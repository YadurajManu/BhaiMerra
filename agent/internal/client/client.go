// Package client is the agent's side of the control-plane contract.
package client

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"time"

	"github.com/fleet-os/fleet-os/agent/internal/capability"
)

type Client struct {
	baseURL string
	token   string
	http    *http.Client
}

func New(baseURL, token string) *Client {
	return &Client{
		baseURL: baseURL,
		token:   token,
		// Deliberately shorter than the heartbeat interval: a request that
		// outlives its own tick is useless and would queue up behind itself.
		http: &http.Client{Timeout: 10 * time.Second},
	}
}

// SetToken swaps the pairing token for the long-lived agent credential.
func (c *Client) SetToken(token string) { c.token = token }

type RegisterResponse struct {
	NodeID               string `json:"node_id"`
	FleetID              string `json:"fleet_id"`
	Name                 string `json:"name"`
	AgentToken           string `json:"agent_token"`
	HeartbeatIntervalSec int    `json:"heartbeat_interval_sec"`
}

type Container struct {
	Name  string `json:"name"`
	State string `json:"state"`
	// Docker's own health verdict: healthy, unhealthy, starting, or empty when
	// the image declares no check. The control plane will not call a deployment
	// running on the strength of "the process started".
	Health string `json:"health,omitempty"`
	// Which deployment this container belongs to. During a rollout two
	// containers of the same service are up at once, and the service name alone
	// cannot say which of them the control plane is waiting on.
	DeploymentID string `json:"deployment_id,omitempty"`
}

type Heartbeat struct {
	CPUPct        float64     `json:"cpu_pct"`
	RAMUsedMb     int         `json:"ram_used_mb"`
	DiskUsedMb    int         `json:"disk_used_mb"`
	MeshConnected bool        `json:"mesh_connected"`
	AgentVersion  string      `json:"agent_version,omitempty"`
	AdvertiseAddr string      `json:"advertise_addr,omitempty"`
	Containers    []Container `json:"containers"`
	Runtime       Runtime     `json:"runtime"`
	Logs          []LogTail   `json:"logs"`
}

// Runtime is deliberately observational. In particular registryStatus becomes
// "ok" only after reconciliation has completed an authenticated image pull.
type Runtime struct {
	DockerAvailable    bool   `json:"docker_available"`
	DockerVersion      string `json:"docker_version,omitempty"`
	DockerAPIVersion   string `json:"docker_api_version,omitempty"`
	DockerError        string `json:"docker_error,omitempty"`
	RegistryStatus     string `json:"registry_status,omitempty"` // ok | failed | not_tested
	RegistryError      string `json:"registry_error,omitempty"`
	LastReconcileError string `json:"last_reconcile_error,omitempty"`
}

// LogTail is a bounded latest snapshot, never an unbounded stream. It lets
// the control plane offer live tails without making inbound connections to a
// private node or storing application output indefinitely.
type LogTail struct {
	Service string `json:"service"`
	Text    string `json:"text"`
}

type HeartbeatResponse struct {
	OK          bool `json:"ok"`
	IntervalSec int  `json:"interval_sec"`
}

type DesiredService struct {
	Name            string `json:"name"`
	DeploymentID    string `json:"deployment_id"`
	Image           string `json:"image"`
	HealthCheckPath string `json:"health_check_path"`
	HealthInterval  int    `json:"health_interval_sec"`
	HealthTimeout   int    `json:"health_timeout_sec"`
	HealthDisabled  bool   `json:"health_disabled"`
	Volume          string `json:"volume"`
	// Where the volume is mounted. Empty falls back to /data, which is right
	// for a service that did not say and wrong for every database.
	VolumePath    string `json:"volume_path"`
	MemoryMb      int    `json:"memory_mb"`
	Replicas      int    `json:"replicas"`
	HostPort      int    `json:"host_port"`
	ContainerPort int    `json:"container_port"`
	// Plain manifest values merged with resolved secrets. This is the only
	// field on the wire that carries credentials, which is why the agent never
	// logs a DesiredService whole — see the redaction in reconcile.
	Env map[string]string `json:"env"`
}

type DesiredState struct {
	NodeID      string           `json:"node_id"`
	GeneratedAt string           `json:"generated_at"`
	Services    []DesiredService `json:"services"`
}

// APIError carries the control plane's machine-readable code so the agent can
// branch on it — notably to tell "retry later" apart from "your token is dead".
type APIError struct {
	StatusCode int
	Code       string
	Message    string
}

func (e *APIError) Error() string {
	return fmt.Sprintf("control plane %d %s: %s", e.StatusCode, e.Code, e.Message)
}

// Fatal reports whether retrying could ever succeed. A revoked token will
// never start working again, so the agent should stop rather than hammer.
func (e *APIError) Fatal() bool {
	return e.StatusCode == http.StatusUnauthorized || e.StatusCode == http.StatusForbidden
}

func (c *Client) do(ctx context.Context, method, path string, body, out any) error {
	var reader io.Reader
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			return fmt.Errorf("encode request: %w", err)
		}
		reader = bytes.NewReader(encoded)
	}

	req, err := http.NewRequestWithContext(ctx, method, c.baseURL+path, reader)
	if err != nil {
		return fmt.Errorf("build request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+c.token)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}

	resp, err := c.http.Do(req)
	if err != nil {
		return fmt.Errorf("%s %s: %w", method, path, err)
	}
	defer resp.Body.Close()

	payload, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return fmt.Errorf("read response: %w", err)
	}

	if resp.StatusCode >= 400 {
		var wrapper struct {
			Error struct {
				Code    string `json:"code"`
				Message string `json:"message"`
			} `json:"error"`
		}
		_ = json.Unmarshal(payload, &wrapper)
		if wrapper.Error.Code == "" {
			wrapper.Error.Code = "unknown"
			wrapper.Error.Message = string(payload)
		}
		return &APIError{StatusCode: resp.StatusCode, Code: wrapper.Error.Code, Message: wrapper.Error.Message}
	}

	if out == nil {
		return nil
	}
	if err := json.Unmarshal(payload, out); err != nil {
		return fmt.Errorf("decode response: %w", err)
	}
	return nil
}

func (c *Client) Register(ctx context.Context, report capability.Report) (*RegisterResponse, error) {
	var out RegisterResponse
	if err := c.do(ctx, http.MethodPost, "/agent/register", report, &out); err != nil {
		return nil, err
	}
	if out.AgentToken == "" {
		return nil, errors.New("control plane returned no agent token")
	}
	return &out, nil
}

func (c *Client) SendHeartbeat(ctx context.Context, hb Heartbeat) (*HeartbeatResponse, error) {
	var out HeartbeatResponse
	if err := c.do(ctx, http.MethodPost, "/agent/heartbeat", hb, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

func (c *Client) DesiredState(ctx context.Context) (*DesiredState, error) {
	var out DesiredState
	if err := c.do(ctx, http.MethodGet, "/agent/desired-state", nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

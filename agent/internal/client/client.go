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
	"strings"
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
	CPUPct     float64 `json:"cpu_pct"`
	RAMUsedMb  int     `json:"ram_used_mb"`
	DiskUsedMb int     `json:"disk_used_mb"`
	// Capacity, not what is left. The capability report's disk_mb is FREE
	// space and is what the scheduler places against; this is the denominator
	// a "used of total" reading needs.
	DiskTotalMb int `json:"disk_total_mb"`
	// Optional host metrics. Omitted rather than zeroed when a platform cannot
	// measure one - a fabricated number is what made the Windows disk figure
	// wrong for months, in the dashboard and in the scheduler.
	NetRxKbps     int         `json:"net_rx_kbps,omitempty"`
	NetTxKbps     int         `json:"net_tx_kbps,omitempty"`
	Load1         float64     `json:"load1,omitempty"`
	TempC         float64     `json:"temp_c,omitempty"`
	SwapUsedMb    int         `json:"swap_used_mb,omitempty"`
	UptimeSec     int         `json:"uptime_sec,omitempty"`
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
	// Whether this fleet permits the agent to replace its own binary. Absent
	// means false: a control plane too old to send it is one that was never
	// asked, and defaulting to true would upgrade nodes nobody opted in.
	AgentAutoUpgrade bool `json:"agent_auto_upgrade"`
	// Docker's X-Registry-Auth payload for the fleet registry, or empty when it
	// needs no credentials. A registry reachable from outside the LAN has to
	// require them, and without this the pull fails with a 401 the node cannot
	// do anything about.
	RegistryAuth string `json:"registry_auth,omitempty"`
	// Volume backups waiting on this node. A backup can only be taken where the
	// volume is, and the control plane never reaches into a node — so the work
	// travels with the desired state and the node collects it.
	Backups []BackupJob `json:"backups,omitempty"`
	// Volumes to write back. At most one at a time, and only for a service the
	// control plane has confirmed is stopped — extracting a data directory
	// underneath a running database corrupts it.
	Restores []RestoreJob `json:"restores,omitempty"`
}

// RestoreJob is one archive to write back into a volume.
type RestoreJob struct {
	ID       string `json:"id"`
	Volume   string `json:"volume"`
	Service  string `json:"service"`
	BackupID string `json:"backupId"`
}

// BackupJob is one volume the control plane is waiting for a copy of.
type BackupJob struct {
	ID      string `json:"id"`
	Volume  string `json:"volume"`
	Service string `json:"service"`
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

// ClaimBackup tells the control plane this node has started reading a volume.
//
// Claimed rather than assumed: without it a backup whose node died mid-archive
// is indistinguishable from one nothing ever picked up, and the control plane
// has nothing to time out.
func (c *Client) ClaimBackup(ctx context.Context, id string) error {
	return c.do(ctx, http.MethodPost, "/agent/backups/"+id+"/claim", nil, nil)
}

// FailBackup reports why a backup could not be made.
func (c *Client) FailBackup(ctx context.Context, id, reason string) error {
	return c.do(ctx, http.MethodPost, "/agent/backups/"+id+"/fail", map[string]string{"reason": reason}, nil)
}

// UploadBackup sends the archive.
//
// Not routed through `do`, which encodes JSON and caps the response it reads —
// this body is measured in gigabytes and is already compressed.
func (c *Client) UploadBackup(ctx context.Context, id string, archive []byte) error {
	req, err := http.NewRequestWithContext(
		ctx, http.MethodPost, c.baseURL+"/agent/backups/"+id, bytes.NewReader(archive),
	)
	if err != nil {
		return fmt.Errorf("build upload: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+c.token)
	req.Header.Set("Content-Type", "application/octet-stream")
	req.ContentLength = int64(len(archive))

	resp, err := c.http.Do(req)
	if err != nil {
		return fmt.Errorf("upload backup: %w", err)
	}
	defer resp.Body.Close()

	payload, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode >= 400 {
		return &APIError{StatusCode: resp.StatusCode, Message: strings.TrimSpace(string(payload))}
	}
	return nil
}

// FetchRestore streams the archive for a restore. The caller closes it.
func (c *Client) FetchRestore(ctx context.Context, id string) (io.ReadCloser, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.baseURL+"/agent/restores/"+id+"/archive", nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+c.token)

	resp, err := c.http.Do(req)
	if err != nil {
		return nil, fmt.Errorf("fetch restore: %w", err)
	}
	if resp.StatusCode >= 400 {
		payload, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
		resp.Body.Close()
		return nil, &APIError{StatusCode: resp.StatusCode, Message: strings.TrimSpace(string(payload))}
	}
	return resp.Body, nil
}

// CompleteRestore reports that the volume now holds the archive's contents.
func (c *Client) CompleteRestore(ctx context.Context, id string) error {
	return c.do(ctx, http.MethodPost, "/agent/restores/"+id+"/done", nil, nil)
}

// FailRestore reports why a restore could not be completed.
func (c *Client) FailRestore(ctx context.Context, id, reason string) error {
	return c.do(ctx, http.MethodPost, "/agent/restores/"+id+"/fail", map[string]string{"reason": reason}, nil)
}

// PublishedSums fetches the checksums the control plane publishes beside the
// agent binaries it serves.
//
// Plain text, not JSON, and deliberately unauthenticated on the server: it is
// the same file the install script reads before anyone has a token. It uses a
// longer deadline than c.http allows, because this is not on the heartbeat
// path and a slow link should not turn into "no upgrade available".
func (c *Client) PublishedSums(ctx context.Context) (string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.baseURL+"/install/SHA256SUMS", nil)
	if err != nil {
		return "", err
	}
	res, err := (&http.Client{Timeout: 30 * time.Second}).Do(req)
	if err != nil {
		return "", err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return "", fmt.Errorf("SHA256SUMS: unexpected status %d", res.StatusCode)
	}
	// Bounded: a checksum file is a few hundred bytes, and anything vastly
	// larger is not one.
	body, err := io.ReadAll(io.LimitReader(res.Body, 64*1024))
	if err != nil {
		return "", err
	}
	return string(body), nil
}

// DownloadAgent streams one published binary.
//
// The caller closes the body, and verifies the checksum before the bytes are
// allowed anywhere near disk as an executable. Nothing here trusts the
// download; the transport is only a transport.
func (c *Client) DownloadAgent(ctx context.Context, binary string) (io.ReadCloser, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.baseURL+"/install/"+binary, nil)
	if err != nil {
		return nil, err
	}
	// Several minutes, not seconds: this is ~7 MB to a Raspberry Pi on a
	// domestic connection, and a timeout here means the node never upgrades.
	res, err := (&http.Client{Timeout: 10 * time.Minute}).Do(req)
	if err != nil {
		return nil, err
	}
	if res.StatusCode != http.StatusOK {
		res.Body.Close()
		return nil, fmt.Errorf("download %s: unexpected status %d", binary, res.StatusCode)
	}
	return res.Body, nil
}

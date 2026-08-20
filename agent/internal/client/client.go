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
	Name   string `json:"name"`
	State  string `json:"state"`
	Health string `json:"health,omitempty"`
}

type Heartbeat struct {
	CPUPct        float64     `json:"cpu_pct"`
	RAMUsedMb     int         `json:"ram_used_mb"`
	DiskUsedMb    int         `json:"disk_used_mb"`
	MeshConnected bool        `json:"mesh_connected"`
	AgentVersion  string      `json:"agent_version,omitempty"`
	Containers    []Container `json:"containers"`
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
	Volume          string `json:"volume"`
	Replicas        int    `json:"replicas"`
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

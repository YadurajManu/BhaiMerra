// Package docker drives the local container runtime.
//
// It speaks the Docker Engine HTTP API over the unix socket directly rather
// than importing the official SDK. The SDK pulls in a very large dependency
// tree; the agent has a <50MB resident target (PRD §9) and ships as a single
// static binary with no runtime dependency, and the handful of endpoints
// needed here is a few hundred lines.
package docker

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Labels stamped on every container the agent owns. Anything without
// LabelManaged is somebody else's and is never touched.
const (
	LabelManaged    = "fleet-os.managed"
	LabelService    = "fleet-os.service"
	LabelDeployment = "fleet-os.deployment"
	LabelNode       = "fleet-os.node"
)

// preferredAPI is what the agent asks for. The daemon may be older or newer;
// negotiate() clamps into whatever range it actually supports.
const preferredAPI = "1.44"

type Client struct {
	http *http.Client
	host string

	mu         sync.Mutex
	apiVersion string // "v1.44", once negotiated
}

// New connects over the unix socket, honouring DOCKER_HOST when set.
func New() *Client {
	socket := "/var/run/docker.sock"
	if host := os.Getenv("DOCKER_HOST"); strings.HasPrefix(host, "unix://") {
		socket = strings.TrimPrefix(host, "unix://")
	}

	return &Client{
		host: socket,
		http: &http.Client{
			Transport: &http.Transport{
				DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
					return (&net.Dialer{}).DialContext(ctx, "unix", socket)
				},
			},
			// Image pulls can be slow on a domestic connection; the caller
			// passes a context with its own deadline for those.
			Timeout: 0,
		},
	}
}

type versionResponse struct {
	APIVersion    string `json:"ApiVersion"`
	MinAPIVersion string `json:"MinAPIVersion"`
	Version       string `json:"Version"`
}

// api returns the negotiated version prefix, e.g. "v1.44".
//
// Hardcoding a version is a trap: Docker 29 dropped 1.43, and a Raspberry Pi
// running an older daemon will not accept a newer one. The daemon reports the
// range it supports at an unversioned endpoint, so ask once and clamp.
func (c *Client) api(ctx context.Context) string {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.apiVersion != "" {
		return c.apiVersion
	}

	c.apiVersion = "v" + preferredAPI // fall back to the preferred version
	var v versionResponse
	if err := c.request(ctx, http.MethodGet, "/version", nil, &v); err == nil {
		chosen := preferredAPI
		if v.APIVersion != "" && compareVersions(v.APIVersion, chosen) < 0 {
			chosen = v.APIVersion // daemon is older than we would like
		}
		if v.MinAPIVersion != "" && compareVersions(chosen, v.MinAPIVersion) < 0 {
			chosen = v.MinAPIVersion // daemon has dropped the version we asked for
		}
		c.apiVersion = "v" + chosen
	}
	return c.apiVersion
}

// compareVersions orders dotted versions numerically: "1.9" < "1.44".
func compareVersions(a, b string) int {
	aParts := strings.Split(a, ".")
	bParts := strings.Split(b, ".")
	for i := 0; i < len(aParts) || i < len(bParts); i++ {
		var x, y int
		if i < len(aParts) {
			x, _ = strconv.Atoi(aParts[i])
		}
		if i < len(bParts) {
			y, _ = strconv.Atoi(bParts[i])
		}
		if x != y {
			if x < y {
				return -1
			}
			return 1
		}
	}
	return 0
}

// ServerVersion reports the daemon version, for logging and diagnostics.
func (c *Client) ServerVersion(ctx context.Context) (string, string, error) {
	var v versionResponse
	if err := c.request(ctx, http.MethodGet, "/version", nil, &v); err != nil {
		return "", "", err
	}
	return v.Version, v.APIVersion, nil
}

func (c *Client) do(ctx context.Context, method, path string, body, out any) error {
	return c.request(ctx, method, path, body, out)
}

func (c *Client) request(ctx context.Context, method, path string, body, out any) error {
	var reader io.Reader
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			return fmt.Errorf("encode request: %w", err)
		}
		reader = bytes.NewReader(encoded)
	}

	req, err := http.NewRequestWithContext(ctx, method, "http://docker"+path, reader)
	if err != nil {
		return err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}

	resp, err := c.http.Do(req)
	if err != nil {
		return fmt.Errorf("docker %s %s: %w", method, path, err)
	}
	defer resp.Body.Close()

	payload, err := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	if err != nil {
		return err
	}

	if resp.StatusCode >= 400 {
		var e struct {
			Message string `json:"message"`
		}
		_ = json.Unmarshal(payload, &e)
		if e.Message == "" {
			e.Message = strings.TrimSpace(string(payload))
		}
		return &Error{StatusCode: resp.StatusCode, Message: e.Message}
	}

	if out == nil {
		return nil
	}
	return json.Unmarshal(payload, out)
}

type Error struct {
	StatusCode int
	Message    string
}

func (e *Error) Error() string { return fmt.Sprintf("docker %d: %s", e.StatusCode, e.Message) }

// NotFound distinguishes "no such container" from a real failure, so callers
// can treat a missing container as "nothing to remove" rather than an error.
func (e *Error) NotFound() bool { return e.StatusCode == http.StatusNotFound }

func IsNotFound(err error) bool {
	var de *Error
	if ok := asError(err, &de); ok {
		return de.NotFound()
	}
	return false
}

func asError(err error, target **Error) bool {
	for err != nil {
		if e, ok := err.(*Error); ok {
			*target = e
			return true
		}
		u, ok := err.(interface{ Unwrap() error })
		if !ok {
			return false
		}
		err = u.Unwrap()
	}
	return false
}

// Ping reports whether the daemon is reachable. A node whose Docker is down
// still heartbeats — it is alive, it just cannot run workloads — so callers
// treat this as information, not a fatal error.
func (c *Client) Ping(ctx context.Context) error {
	ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	return c.do(ctx, http.MethodGet, "/"+c.api(ctx)+"/_ping", nil, nil)
}

type ContainerSummary struct {
	ID     string            `json:"Id"`
	Names  []string          `json:"Names"`
	Image  string            `json:"Image"`
	State  string            `json:"State"`
	Status string            `json:"Status"`
	Labels map[string]string `json:"Labels"`
}

// ListManaged returns only containers this agent owns.
func (c *Client) ListManaged(ctx context.Context) ([]ContainerSummary, error) {
	filters := url.QueryEscape(`{"label":["` + LabelManaged + `=true"]}`)
	var out []ContainerSummary
	err := c.do(ctx, http.MethodGet, "/"+c.api(ctx)+"/containers/json?all=1&filters="+filters, nil, &out)
	return out, err
}

type inspectResponse struct {
	ID    string `json:"Id"`
	State struct {
		Status   string `json:"Status"`
		Running  bool   `json:"Running"`
		ExitCode int    `json:"ExitCode"`
		Health   *struct {
			Status string `json:"Status"`
		} `json:"Health"`
	} `json:"State"`
	Config struct {
		Image  string            `json:"Image"`
		Labels map[string]string `json:"Labels"`
	} `json:"Config"`
}

type ContainerState struct {
	ID       string
	Running  bool
	Status   string
	Health   string
	ExitCode int
	Image    string
	Labels   map[string]string
}

func (c *Client) Inspect(ctx context.Context, name string) (*ContainerState, error) {
	var out inspectResponse
	if err := c.do(ctx, http.MethodGet, "/"+c.api(ctx)+"/containers/"+name+"/json", nil, &out); err != nil {
		return nil, err
	}
	state := &ContainerState{
		ID:       out.ID,
		Running:  out.State.Running,
		Status:   out.State.Status,
		ExitCode: out.State.ExitCode,
		Image:    out.Config.Image,
		Labels:   out.Config.Labels,
	}
	if out.State.Health != nil {
		state.Health = out.State.Health.Status
	}
	return state, nil
}

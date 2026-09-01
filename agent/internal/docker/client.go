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
	"os/exec"
	"path/filepath"
	"runtime"
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
	// Image used to mount a volume for backup and restore. Any image already on
	// the node will do — nothing is executed inside the container, it exists
	// only to give the volume a mount point Docker can copy through.
	RestoreImage string

	http *http.Client
	// Where the daemon was looked for, for diagnostics.
	host      string
	endpoints []endpoint

	mu         sync.Mutex
	apiVersion string // "v1.44", once negotiated

	startMu   sync.Mutex
	statePath string // "" keeps the auto-start decision in memory only
	loaded    bool
	mem       autostartMemory
	// How to actually launch the daemon. A field rather than a direct call so a
	// unit test can assert on the decision without launching Docker on the
	// machine running the test.
	start func()

	netMu        sync.Mutex
	networkReady bool // the fleet network has been created on this daemon
}

// autostartMemory is the part of the auto-start decision that has to outlive
// the process.
//
// This used to be three plain struct fields, which made the "cold" policy a
// promise the agent could not keep. Both supervisors shipped by the installer
// restart the agent on their own — systemd with Restart=, launchd with
// KeepAlive — and every fresh process started with everHealthy false. So the
// first thing a restarted agent did was relaunch the daemon the operator had
// just quit, which is precisely what the policy exists to prevent. Persisting
// it is what makes "a daemon that was up and is now down is a person, not a
// fault" true beyond one process lifetime.
//
// The attempt budget is persisted for the same reason: an agent caught in a
// crash-restart loop would otherwise get a fresh three attempts every few
// seconds, which is an unbounded number of them.
type autostartMemory struct {
	// The daemon has answered at least once on this node, ever.
	EverHealthy bool `json:"ever_healthy"`
	// How many starts have been attempted since it was last seen healthy.
	Attempts int `json:"attempts"`
	// When the last start was attempted, for the cooldown.
	LastAttempt time.Time `json:"last_attempt"`
}

const autostartFile = "docker-autostart.json"

// New connects over the unix socket or TCP socket, honouring DOCKER_HOST when set.
//
// stateDir is where the auto-start decision is persisted; it is the directory
// holding agent.json, which the systemd unit already grants write access to.
// Pass "" to keep the decision in memory only, which is what tests want.
func New(stateDir string) *Client {
	endpoints := endpointsFor(os.Getenv("DOCKER_HOST"))

	statePath := ""
	if stateDir != "" {
		statePath = filepath.Join(stateDir, autostartFile)
	}

	c := &Client{
		host:      endpoints[0].String(),
		endpoints: endpoints,
		statePath: statePath,
		http: &http.Client{
			Transport: &http.Transport{
				DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
					// Try each transport in turn. On Windows that is the named
					// pipe and then the optional TCP port; everywhere else there
					// is only ever one.
					var last error
					for _, e := range endpoints {
						conn, err := dialEndpoint(ctx, e)
						if err == nil {
							return conn, nil
						}
						last = err
					}
					return nil, unreachable(endpoints, last)
				},
			},
			// Image pulls can be slow on a domestic connection; the caller
			// passes a context with its own deadline for those.
			Timeout: 0,
		},
	}
	c.start = c.startDaemon
	return c
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

// Auto-start policy, from FLEET_DOCKER_AUTOSTART.
//
//	"cold" (default) — start the daemon only if it has never answered in this
//	                   process. A daemon that was up and is now down is treated
//	                   as a deliberate human action.
//	"always"         — start it whenever it is found down. The old behaviour.
//	"never"          — never start it; only report.
const (
	autostartCold   = "cold"
	autostartAlways = "always"
	autostartNever  = "never"
)

// How long to wait between start attempts, and how many to make before giving
// up, so a machine with a broken Docker install is not respawning it forever.
const (
	startCooldown = 2 * time.Minute
	maxAttempts   = 3
)

func autostartPolicy() string {
	switch strings.ToLower(strings.TrimSpace(os.Getenv("FLEET_DOCKER_AUTOSTART"))) {
	case "never", "0", "false", "off":
		return autostartNever
	case "always", "1", "true", "on":
		return autostartAlways
	default:
		return autostartCold
	}
}

// loadLocked reads the persisted decision once. Caller holds startMu.
//
// A missing or unreadable file is not an error worth surfacing: it means a
// first run, or a state directory the agent cannot read, and in both cases the
// in-memory zero value is the correct starting point.
func (c *Client) loadLocked() {
	if c.loaded {
		return
	}
	c.loaded = true
	if c.statePath == "" {
		return
	}
	data, err := os.ReadFile(c.statePath)
	if err != nil {
		return
	}
	_ = json.Unmarshal(data, &c.mem)
}

// persist writes the decision back. Best effort on purpose: a read-only state
// directory must degrade to the old in-memory behaviour, not stop the agent
// from talking to Docker at all.
func (c *Client) persist(mem autostartMemory) {
	if c.statePath == "" {
		return
	}
	data, err := json.Marshal(mem)
	if err != nil {
		return
	}
	if err := os.MkdirAll(filepath.Dir(c.statePath), 0o700); err != nil {
		return
	}
	// Write-then-rename, so a crash mid-write cannot leave a truncated file
	// that would read back as "never healthy" and relaunch Docker.
	tmp := c.statePath + ".tmp"
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return
	}
	if err := os.Rename(tmp, c.statePath); err != nil {
		_ = os.Remove(tmp)
	}
}

// EnsureRunning brings the container daemon up if policy allows it.
//
// The default is deliberately restrained. This used to fire from Ping on every
// failed probe, which meant heartbeat (every interval) and reconcile (every
// interval*2) each re-launched Docker within seconds of a user quitting it —
// making Docker impossible to stop by hand on a paired machine. Helping someone
// through a cold start is worth doing; overriding a decision they just made is
// not, and a node whose Docker is down already reports that truthfully and has
// its workloads rescheduled by the control plane.
//
// Returns whether a start was actually attempted.
func (c *Client) EnsureRunning(ctx context.Context) bool {
	policy := autostartPolicy()
	if policy == autostartNever {
		return false
	}

	c.startMu.Lock()
	c.loadLocked()
	if policy == autostartCold && c.mem.EverHealthy {
		// It was up, and now it is not. That is a person, not a fault — and
		// because this is read from disk, it stays a person's decision across
		// the restart the supervisor is about to perform.
		c.startMu.Unlock()
		return false
	}
	if c.mem.Attempts >= maxAttempts {
		c.startMu.Unlock()
		return false
	}
	if !c.mem.LastAttempt.IsZero() && time.Since(c.mem.LastAttempt) < startCooldown {
		c.startMu.Unlock()
		return false
	}
	c.mem.LastAttempt = time.Now()
	c.mem.Attempts++
	snapshot := c.mem
	c.startMu.Unlock()

	// Record the attempt before making it. A daemon that takes the whole
	// cooldown to come up must not be asked again by the next restart.
	c.persist(snapshot)

	c.start()
	return true
}

func (c *Client) startDaemon() {
	if runtime.GOOS == "linux" {
		// If running under WSL, launch Docker Desktop on Windows host only if present
		if os.Getenv("WSL_DISTRO_NAME") != "" || strings.Contains(os.Getenv("PATH"), "/mnt/c") {
			tryStartExecutable(
				"/mnt/c/Program Files/Docker/Docker/Docker Desktop.exe",
				"/mnt/c/Program Files/Docker/Docker Desktop.exe",
			)
		}
		_ = exec.Command("systemctl", "start", "docker").Run()
		_ = exec.Command("service", "docker", "start").Run()
		_ = exec.Command("/etc/init.d/docker", "start").Run()
	} else if runtime.GOOS == "darwin" {
		_ = exec.Command("open", "-a", "Docker").Run()
	} else if runtime.GOOS == "windows" {
		programFiles := os.Getenv("ProgramFiles")
		if programFiles == "" {
			programFiles = `C:\Program Files`
		}
		localAppData := os.Getenv("LocalAppData")

		candidates := []string{
			filepath.Join(programFiles, "Docker", "Docker", "Docker Desktop.exe"),
			filepath.Join(programFiles, "Docker", "Docker Desktop.exe"),
		}
		if localAppData != "" {
			candidates = append(candidates, filepath.Join(localAppData, "Programs", "Docker", "Docker", "Docker Desktop.exe"))
		}

		tryStartExecutable(candidates...)
		_ = exec.Command("net", "start", "docker").Run()
	}
}

func tryStartExecutable(paths ...string) {
	for _, p := range paths {
		if _, err := os.Stat(p); err == nil {
			cmd := exec.Command(p)
			_ = cmd.Start()
			return
		}
	}
}

// Ping reports whether the daemon is reachable.
//
// A pure probe with no side effects: it is called from the heartbeat and from
// the diagnostics reporter, both of which only want to know the answer. Bringing
// the daemon up is EnsureRunning's job, and the caller decides when that is
// appropriate.
func (c *Client) Ping(ctx context.Context) error {
	ctxTimeout, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	err := c.do(ctxTimeout, http.MethodGet, "/"+c.api(ctxTimeout)+"/_ping", nil, nil)
	if err == nil {
		c.startMu.Lock()
		c.loadLocked()
		// Only a transition is worth a write. Ping runs on every heartbeat, and
		// this is a flash-backed SD card on a Raspberry Pi as often as not.
		changed := !c.mem.EverHealthy || c.mem.Attempts != 0
		c.mem.EverHealthy = true
		// A daemon that came back resets the budget, so a genuine crash weeks
		// later still gets helped.
		c.mem.Attempts = 0
		c.mem.LastAttempt = time.Time{}
		snapshot := c.mem
		c.startMu.Unlock()

		if changed {
			c.persist(snapshot)
		}
	}
	return err
}

// PingOrStart probes the daemon and, if it is down, asks EnsureRunning to bring
// it up before probing once more. Used where the agent actually needs Docker in
// order to make progress, not merely to report on it.
func (c *Client) PingOrStart(ctx context.Context) error {
	err := c.Ping(ctx)
	if err == nil {
		return err
	}
	if !c.EnsureRunning(ctx) {
		return err
	}
	return c.Ping(ctx)
}

type ContainerSummary struct {
	ID     string            `json:"Id"`
	Names  []string          `json:"Names"`
	Image  string            `json:"Image"`
	State  string            `json:"State"`
	Status string            `json:"Status"`
	Labels map[string]string `json:"Labels"`
	// Which networks the container is attached to. Reconciliation uses this to
	// notice a container that predates the fleet network and replace it.
	NetworkSettings *struct {
		Networks map[string]struct{} `json:"Networks"`
	} `json:"NetworkSettings"`
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

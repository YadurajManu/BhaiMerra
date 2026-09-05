// Package reconcile converges what is running locally toward what the control
// plane says should be running here.
//
// The agent never decides placement (tech doc §7). It is told, and it makes
// the node match. Anything it cannot make match is reported, not guessed at.
package reconcile

import (
	"context"
	"fmt"
	"log/slog"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/fleet-os/fleet-os/agent/internal/client"
	"github.com/fleet-os/fleet-os/agent/internal/docker"
	"github.com/fleet-os/fleet-os/agent/internal/health"
)

type Engine struct {
	Docker *docker.Client
	Client *client.Client
	NodeID string
	Log    *slog.Logger
	// Health probes services over their published host port. Optional: a nil
	// prober simply leaves Docker's own verdict in place, which is what every
	// test that does not care about health gets.
	Health *health.Prober
	// Discover asks a service with no health check which paths it answers, so
	// the manifest can record one instead of telling the reader to go and find
	// out. Optional, like Health: nil simply reports no candidates.
	Discover *health.Discoverer

	// Last known memory per container, and when it was taken.
	//
	// Sampled on its own cadence rather than per heartbeat. Docker's stats
	// endpoint is not free, the heartbeat runs every five seconds, and a
	// reservation is decided from a steady state -- so a minute-old reading is
	// exactly as useful as a fresh one and costs the heartbeat nothing.
	memMu    sync.Mutex
	memory   map[string]int
	memoryAt time.Time
	memBusy  bool

	// Whether a reconcile pass has completed since this process started.
	//
	// Only ever touched by the reconcile goroutine, which is the single caller
	// of Reconcile, so it needs no synchronisation.
	settled bool
}

// probeTargets is the subset of desired state the agent can probe itself:
// health enabled, a path to ask for, and a host port to ask on.
func probeTargets(desired *client.DesiredState) []health.Target {
	if desired == nil {
		return nil
	}
	targets := make([]health.Target, 0, len(desired.Services))
	for _, svc := range desired.Services {
		if svc.HealthDisabled || svc.HealthCheckPath == "" || svc.HostPort <= 0 {
			continue
		}
		path := svc.HealthCheckPath
		if !strings.HasPrefix(path, "/") {
			path = "/" + path
		}
		targets = append(targets, health.Target{
			DeploymentID: svc.DeploymentID,
			// Loopback rather than the node's routable address. The port is
			// published on every interface, but the loopback route is the one
			// no firewall rule written for outsiders can take away.
			URL:      fmt.Sprintf("http://127.0.0.1:%d%s", svc.HostPort, path),
			Interval: time.Duration(svc.HealthInterval) * time.Second,
			Timeout:  time.Duration(svc.HealthTimeout) * time.Second,
		})
	}
	return targets
}

// discoverTargets is the exact complement of probeTargets: every service the
// agent is not already probing, because nobody has said what to ask for.
//
// Written as the complement rather than as its own set of conditions on
// purpose. The two must partition the services between them -- a service in
// neither is one nothing ever asks about, and a service in both would be
// probed continuously and swept as though it were not. Deriving one from the
// other is what keeps that true when either changes.
//
// This deliberately includes a service whose check is switched off explicitly.
// The sweep settles once per deployment either way, and what it finds is worth
// reporting: "you turned the check off, and for what it is worth /health does
// answer" is information, and the manifest is still the operator's to decide.
func discoverTargets(desired *client.DesiredState) []health.DiscoverTarget {
	if desired == nil {
		return nil
	}
	targets := make([]health.DiscoverTarget, 0, len(desired.Services))
	for _, svc := range desired.Services {
		probed := !svc.HealthDisabled && svc.HealthCheckPath != ""
		if probed || svc.HostPort <= 0 {
			continue
		}
		targets = append(targets, health.DiscoverTarget{
			DeploymentID: svc.DeploymentID,
			// Loopback, for the same reason the prober uses it: it is the one
			// route no firewall rule written for outsiders can take away.
			BaseURL: fmt.Sprintf("http://127.0.0.1:%d", svc.HostPort),
		})
	}
	return targets
}

// MemorySampleInterval is how often each container's usage is re-read.
//
// A reservation covers a steady state, and a steady state does not move in a
// minute. The cost of a shorter interval is a stats call per container per
// node, for ever, to watch a number that barely changes.
const MemorySampleInterval = 60 * time.Second

// memorySnapshot returns the last readings, and starts a refresh if they are
// stale.
//
// Asynchronous on purpose: this runs on the heartbeat path, and a node whose
// Docker is slow to answer must not delay its heartbeat past the point the
// control plane calls it down. The first heartbeat after startup carries no
// memory at all, which is honest -- nothing has been measured yet.
func (e *Engine) memorySnapshot(ctx context.Context, names []string) map[string]int {
	e.memMu.Lock()
	snapshot := make(map[string]int, len(e.memory))
	for k, v := range e.memory {
		snapshot[k] = v
	}
	stale := time.Since(e.memoryAt) >= MemorySampleInterval
	start := stale && !e.memBusy
	if start {
		e.memBusy = true
	}
	e.memMu.Unlock()

	if !start {
		return snapshot
	}

	go func() {
		fresh := make(map[string]int, len(names))
		for _, name := range names {
			// One at a time. These are local socket calls against a daemon
			// that is also building and running containers, and a burst of
			// them from a node with twenty services is a worse neighbour than
			// a sample that takes a moment longer.
			mb, err := e.Docker.MemoryUsage(ctx, name)
			if err != nil {
				continue
			}
			fresh[name] = mb
		}

		e.memMu.Lock()
		e.memory = fresh
		e.memoryAt = time.Now()
		e.memBusy = false
		e.memMu.Unlock()
	}()

	return snapshot
}

type Action struct {
	Service string
	Verb    string // started | replaced | stopped | unchanged | held | failed
	Detail  string
}

// Reconcile makes one pass: start what should run, replace what is running the
// wrong deployment, and stop what is no longer wanted.
func (e *Engine) Reconcile(ctx context.Context, desired *client.DesiredState) ([]Action, error) {
	// Told before anything is started, so a service that comes up between here
	// and the next pass is already being watched when its first heartbeat is
	// assembled.
	if e.Health != nil {
		e.Health.Track(probeTargets(desired))
	}
	if e.Discover != nil {
		e.Discover.Sweep(ctx, discoverTargets(desired))
	}

	// Reconciliation is the one path that cannot proceed without Docker, so
	// this is where an auto-start is worth attempting. Policy inside
	// PingOrStart decides whether it actually happens — by default it will not
	// restart a daemon the operator has deliberately stopped.
	if err := e.Docker.PingOrStart(ctx); err != nil {
		// A node with no container runtime is still a live node. Say so
		// clearly instead of failing the whole agent.
		return nil, fmt.Errorf("container runtime unavailable: %w", err)
	}

	// Before anything is started: without this network there is no DNS between
	// containers, so a service can only be reached by an address that changes
	// on every restart. Idempotent and cached, so this is one call on the first
	// pass and free afterwards.
	if err := e.Docker.EnsureNetwork(ctx); err != nil {
		return nil, fmt.Errorf("create the %s network: %w", docker.NetworkName, err)
	}

	running, err := e.Docker.ListManaged(ctx)
	if err != nil {
		return nil, fmt.Errorf("list managed containers: %w", err)
	}

	// Keyed by deployment, not by service.
	//
	// During a rollout a service has two live deployments: the release that is
	// serving and the one being checked. Keying by service name collapses them
	// into one entry and the second silently overwrites the first, which makes
	// an overlapping rollout impossible to represent.
	byDeployment := make(map[string]docker.ContainerSummary, len(running))
	for _, c := range running {
		if id := c.Labels[docker.LabelDeployment]; id != "" {
			byDeployment[id] = c
		}
	}

	actions := make([]Action, 0, len(desired.Services)+len(running))
	wanted := make(map[string]struct{}, len(desired.Services))
	removed := make(map[string]struct{}, len(running))

	for _, svc := range desired.Services {
		wanted[svc.DeploymentID] = struct{}{}

		if svc.Image == "" {
			actions = append(actions, Action{svc.Name, "failed", "no image in desired state"})
			continue
		}

		existing, present := byDeployment[svc.DeploymentID]
		// A container from before the fleet network existed is running the
		// right image under the right deployment, so every other check passes —
		// and it cannot resolve a single one of its neighbours. Treat being off
		// the network as a reason to replace, or those containers stay broken
		// until something else happens to redeploy them.
		if present && isUp(existing.State) && docker.OnFleetNetwork(existing) {
			actions = append(actions, Action{svc.Name, "unchanged", existing.State})
			continue
		}

		verb := "started"
		if present {
			// Same deployment, but stopped or on the wrong network. Tear it
			// down before bringing it back, so the name is free.
			verb = "replaced"
			if err := e.Docker.Remove(ctx, existing.ID); err != nil {
				actions = append(actions, Action{svc.Name, "failed", "remove old: " + err.Error()})
				continue
			}
			removed[existing.ID] = struct{}{}
		}

		if err := e.start(ctx, svc, desired.RegistryAuth); err != nil {
			actions = append(actions, Action{svc.Name, "failed", err.Error()})
			continue
		}
		actions = append(actions, Action{svc.Name, verb, svc.Image})
	}

	// Anything managed whose deployment is no longer listed: a service that
	// moved away, was removed, or — the common case now — the previous release
	// of a rollout that has just been promoted. Unmanaged containers are never
	// touched, and a container carrying no deployment label cannot be matched
	// to anything, so it goes too.
	for _, c := range running {
		if _, gone := removed[c.ID]; gone {
			continue
		}
		id := c.Labels[docker.LabelDeployment]
		if _, keep := wanted[id]; keep && id != "" {
			continue
		}
		name := c.Labels[docker.LabelService]
		if name == "" {
			name = strings.TrimPrefix(strings.Join(c.Names, ","), "/")
		}

		// Nothing is removed on the first pass after this process starts.
		//
		// This is the one path where a mistake destroys state rather than
		// failing, and a restart is exactly when the control plane's view of
		// this node is most stale: heartbeats and reconciliation start
		// concurrently, so the first desired state can be computed before the
		// control plane has seen us come back. It has already gone wrong once
		// -- an agent restart of about a minute ended with a database
		// container deleted -- and self-upgrade now makes restarts routine.
		//
		// One pass, about ten seconds, is enough for a heartbeat to land and
		// the answer to be about the node as it is now. A container that
		// genuinely should go is removed on the next pass; the cost of being
		// wrong in that direction is a few more seconds of a container that is
		// no longer wanted, against deleting one that is.
		if !e.settled {
			actions = append(actions, Action{name, "held", "not removed until a second pass confirms it"})
			e.Log.Info("holding a removal until the next pass",
				"service", name, "deployment", id,
				"why", "the control plane's view of this node may predate our restart")
			continue
		}

		if err := e.Docker.Remove(ctx, c.ID); err != nil {
			actions = append(actions, Action{name, "failed", "remove: " + err.Error()})
			continue
		}
		actions = append(actions, Action{name, "stopped", "no longer scheduled here"})
	}

	// Only now: a pass that returned early never proved anything about what
	// this node should be running.
	e.settled = true

	return actions, nil
}

func (e *Engine) start(ctx context.Context, svc client.DesiredService, registryAuth string) error {
	pullCtx, cancel := context.WithTimeout(ctx, 10*time.Minute)
	defer cancel()

	// The credential is passed through, never logged. A registry the fleet
	// reaches from outside the LAN requires one, and an empty string is the
	// correct value for a local registry that does not.
	if err := e.Docker.Pull(pullCtx, svc.Image, registryAuth); err != nil {
		return fmt.Errorf("pull: %w", err)
	}

	containerPort := svc.ContainerPort
	if containerPort == 0 {
		containerPort = 8080
	}

	spec := docker.RunSpec{
		Service:       svc.Name,
		DeploymentID:  svc.DeploymentID,
		NodeID:        e.NodeID,
		Image:         svc.Image,
		Volume:        svc.Volume,
		VolumePath:    svc.VolumePath,
		Env:           svc.Env,
		ContainerPort: containerPort,
	}

	// The scheduler reserved this much; hold the container to it. Docker
	// refuses a limit under 6MB, and a service declared that small is a
	// mistake in the manifest rather than an instruction worth honouring.
	const minMemoryMb = 6
	if svc.MemoryMb >= minMemoryMb {
		spec.Memory = int64(svc.MemoryMb) * 1024 * 1024
	}

	// Where the control plane published a host port, the agent probes the
	// service from the node and Docker's own check is switched off. Where it
	// did not — an internal service, reachable only on the fleet network — the
	// in-container probe is still the only way in, so it stays. That fallback
	// depends on the image carrying wget or curl, which is exactly the
	// dependency agent-side probing exists to remove; it survives only because
	// no probe at all would be worse.
	if !svc.HealthDisabled && svc.HealthCheckPath != "" {
		if svc.HostPort > 0 {
			spec.ProbedByAgent = true
		} else {
			spec.Health = &docker.HealthSpec{
				Path:        svc.HealthCheckPath,
				Port:        containerPort,
				IntervalSec: svc.HealthInterval,
				TimeoutSec:  svc.HealthTimeout,
			}
		}
	}

	// Publish the container port on the host port the control plane allocated,
	// so its ingress has somewhere to send traffic. An internal service is sent
	// no host port, and so is never bound on the node's interface.
	if svc.HostPort > 0 {
		spec.Ports = map[string]string{
			fmt.Sprintf("%d/tcp", containerPort): strconv.Itoa(svc.HostPort),
		}
	}

	if _, err := e.Docker.Create(ctx, spec); err != nil {
		return fmt.Errorf("create: %w", err)
	}
	if err := e.Docker.Start(ctx, docker.ContainerName(svc.Name, svc.DeploymentID)); err != nil {
		return fmt.Errorf("start: %w", err)
	}
	return nil
}

func isUp(state string) bool {
	return strings.EqualFold(state, "running")
}

// healthFromStatus reads Docker's health verdict out of a container's Status
// line, and only that.
//
// Docker puts several unrelated things in the same parentheses:
//
//	"Up 2 minutes (healthy)"          -> healthy
//	"Up 40 seconds (health: starting)" -> starting
//	"Up 2 minutes (unhealthy)"        -> unhealthy
//	"Up 3 hours"                      -> "" (no check configured)
//	"Restarting (1) 5 seconds ago"    -> "" — that 1 is an exit code
//	"Exited (0) 3 minutes ago"        -> "" — so is that 0
//
// Taking whatever sat between the first parentheses reported an exit code as a
// health verdict. The control plane reads a non-empty value as "this service
// has a health check", and then waits for it to say exactly "healthy" — so a
// crash-looping container did not merely fail to be promoted, it made itself
// permanently unpromotable while looking like a health problem rather than a
// restart loop.
func healthFromStatus(status string) string {
	open := strings.Index(status, "(")
	if open < 0 {
		return ""
	}
	end := strings.Index(status[open:], ")")
	if end <= 0 {
		return ""
	}
	inner := strings.TrimSpace(status[open+1 : open+end])

	// Docker's own vocabulary, and nothing else.
	switch strings.ToLower(inner) {
	case "healthy", "unhealthy":
		return strings.ToLower(inner)
	case "health: starting":
		return "starting"
	default:
		return ""
	}
}

// Containers implements the sampler's ContainerLister so heartbeats carry the
// real container states back to the control plane.
func (e *Engine) List(ctx context.Context) ([]client.Container, error) {
	summaries, err := e.Docker.ListManaged(ctx)
	if err != nil {
		return nil, err
	}
	// Refreshed here because this is the only place the answer is read: the
	// heartbeat carries it, and a verdict nobody asked for is wasted work.
	if e.Health != nil {
		e.Health.Probe(ctx)
	}

	names := make([]string, 0, len(summaries))
	for _, c := range summaries {
		if len(c.Names) > 0 {
			names = append(names, strings.TrimPrefix(c.Names[0], "/"))
		}
	}
	memory := e.memorySnapshot(ctx, names)

	var discovered map[string][]client.HealthCandidate
	if e.Discover != nil {
		discovered = make(map[string][]client.HealthCandidate)
		for id, found := range e.Discover.Results() {
			wire := make([]client.HealthCandidate, 0, len(found))
			for _, c := range found {
				wire = append(wire, client.HealthCandidate{Path: c.Path, Status: c.Status, Bytes: c.Bytes})
			}
			discovered[id] = wire
		}
	}

	out := make([]client.Container, 0, len(summaries))
	for _, c := range summaries {
		name := c.Labels[docker.LabelService]
		if name == "" {
			name = strings.TrimPrefix(strings.Join(c.Names, ","), "/")
		}
		container := client.Container{
			Name:         name,
			State:        c.State,
			DeploymentID: c.Labels[docker.LabelDeployment],
		}
		container.Health = healthFromStatus(c.Status)
		// The agent's own probe wins where it has one. Docker's verdict is
		// only a fallback now, and an empty status means "not probed", which
		// must never be read as unhealthy.
		if e.Health != nil {
			if s := e.Health.Status(container.DeploymentID); s != "" {
				container.Health = s
			}
		}
		if found, ok := discovered[container.DeploymentID]; ok {
			container.HealthCandidates = found
		}
		if len(c.Names) > 0 {
			if mb, ok := memory[strings.TrimPrefix(c.Names[0], "/")]; ok {
				container.MemoryMb = mb
			}
		}
		out = append(out, container)
	}
	return out, nil
}

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
	"time"

	"github.com/fleet-os/fleet-os/agent/internal/client"
	"github.com/fleet-os/fleet-os/agent/internal/docker"
)

type Engine struct {
	Docker *docker.Client
	Client *client.Client
	NodeID string
	Log    *slog.Logger
}

type Action struct {
	Service string
	Verb    string // started | replaced | stopped | unchanged | failed
	Detail  string
}

// Reconcile makes one pass: start what should run, replace what is running the
// wrong deployment, and stop what is no longer wanted.
func (e *Engine) Reconcile(ctx context.Context, desired *client.DesiredState) ([]Action, error) {
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
		if err := e.Docker.Remove(ctx, c.ID); err != nil {
			actions = append(actions, Action{name, "failed", "remove: " + err.Error()})
			continue
		}
		actions = append(actions, Action{name, "stopped", "no longer scheduled here"})
	}

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

	if !svc.HealthDisabled && svc.HealthCheckPath != "" {
		spec.Health = &docker.HealthSpec{
			Path:        svc.HealthCheckPath,
			Port:        containerPort,
			IntervalSec: svc.HealthInterval,
			TimeoutSec:  svc.HealthTimeout,
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

// Containers implements the sampler's ContainerLister so heartbeats carry the
// real container states back to the control plane.
func (e *Engine) List(ctx context.Context) ([]client.Container, error) {
	summaries, err := e.Docker.ListManaged(ctx)
	if err != nil {
		return nil, err
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
		// Docker reports health inside Status as "Up 2 minutes (healthy)".
		if open := strings.Index(c.Status, "("); open >= 0 {
			if close := strings.Index(c.Status[open:], ")"); close > 0 {
				container.Health = c.Status[open+1 : open+close]
			}
		}
		out = append(out, container)
	}
	return out, nil
}

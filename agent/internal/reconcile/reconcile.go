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
	if err := e.Docker.Ping(ctx); err != nil {
		// A node with no container runtime is still a live node. Say so
		// clearly instead of failing the whole agent.
		return nil, fmt.Errorf("container runtime unavailable: %w", err)
	}

	running, err := e.Docker.ListManaged(ctx)
	if err != nil {
		return nil, fmt.Errorf("list managed containers: %w", err)
	}

	// What is here now, keyed by service.
	current := make(map[string]docker.ContainerSummary, len(running))
	for _, c := range running {
		if svc := c.Labels[docker.LabelService]; svc != "" {
			current[svc] = c
		}
	}

	actions := make([]Action, 0, len(desired.Services)+len(current))
	wanted := make(map[string]struct{}, len(desired.Services))

	for _, svc := range desired.Services {
		wanted[svc.Name] = struct{}{}

		if svc.Image == "" {
			actions = append(actions, Action{svc.Name, "failed", "no image in desired state"})
			continue
		}

		existing, present := current[svc.Name]
		if present && existing.Labels[docker.LabelDeployment] == svc.DeploymentID && isUp(existing.State) {
			actions = append(actions, Action{svc.Name, "unchanged", existing.State})
			continue
		}

		verb := "started"
		if present {
			// A different deployment id, or a stopped container: tear down
			// before bringing up, so the name is free and no stale container
			// lingers holding the port.
			verb = "replaced"
			if err := e.Docker.Remove(ctx, existing.ID); err != nil {
				actions = append(actions, Action{svc.Name, "failed", "remove old: " + err.Error()})
				continue
			}
		}

		if err := e.start(ctx, svc); err != nil {
			actions = append(actions, Action{svc.Name, "failed", err.Error()})
			continue
		}
		actions = append(actions, Action{svc.Name, verb, svc.Image})
	}

	// Anything managed but no longer desired belongs to a service that moved
	// away or was removed. Unmanaged containers are never touched.
	for name, c := range current {
		if _, keep := wanted[name]; keep {
			continue
		}
		if err := e.Docker.Remove(ctx, c.ID); err != nil {
			actions = append(actions, Action{name, "failed", "remove: " + err.Error()})
			continue
		}
		actions = append(actions, Action{name, "stopped", "no longer scheduled here"})
	}

	return actions, nil
}

func (e *Engine) start(ctx context.Context, svc client.DesiredService) error {
	pullCtx, cancel := context.WithTimeout(ctx, 10*time.Minute)
	defer cancel()

	if err := e.Docker.Pull(pullCtx, svc.Image, ""); err != nil {
		return fmt.Errorf("pull: %w", err)
	}

	spec := docker.RunSpec{
		Service:      svc.Name,
		DeploymentID: svc.DeploymentID,
		NodeID:       e.NodeID,
		Image:        svc.Image,
		Volume:       svc.Volume,
		HealthPath:   svc.HealthCheckPath,
	}

	if _, err := e.Docker.Create(ctx, spec); err != nil {
		return fmt.Errorf("create: %w", err)
	}
	if err := e.Docker.Start(ctx, docker.ContainerName(svc.Name)); err != nil {
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
		container := client.Container{Name: name, State: c.State}
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

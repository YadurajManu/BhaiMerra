// Package diagnostics gathers facts the agent can observe locally and carries
// them back on the normal outbound heartbeat path.
package diagnostics

import (
	"context"
	"strings"
	"sync"

	"github.com/fleet-os/fleet-os/agent/internal/client"
	"github.com/fleet-os/fleet-os/agent/internal/docker"
	"github.com/fleet-os/fleet-os/agent/internal/reconcile"
)

type Reporter struct {
	docker             *docker.Client
	mu                 sync.RWMutex
	registryStatus     string
	registryError      string
	lastReconcileError string
	logs               map[string]string
}

func New(d *docker.Client) *Reporter {
	return &Reporter{docker: d, registryStatus: "not_tested", logs: map[string]string{}}
}

func (r *Reporter) Snapshot(ctx context.Context) client.Runtime {
	runtime := client.Runtime{RegistryStatus: "not_tested"}
	if err := r.docker.Ping(ctx); err != nil {
		runtime.DockerError = err.Error()
		r.mu.RLock()
		runtime.RegistryStatus, runtime.RegistryError, runtime.LastReconcileError = r.registryStatus, r.registryError, r.lastReconcileError
		r.mu.RUnlock()
		return runtime
	}
	runtime.DockerAvailable = true
	if version, apiVersion, err := r.docker.ServerVersion(ctx); err != nil {
		runtime.DockerError = err.Error()
	} else {
		runtime.DockerVersion, runtime.DockerAPIVersion = version, apiVersion
	}
	r.mu.RLock()
	runtime.RegistryStatus, runtime.RegistryError, runtime.LastReconcileError = r.registryStatus, r.registryError, r.lastReconcileError
	r.mu.RUnlock()
	return runtime
}

func (r *Reporter) ObserveReconcile(actions []reconcile.Action, reconcileErr error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.lastReconcileError = ""
	if reconcileErr != nil {
		r.lastReconcileError = reconcileErr.Error()
		return
	}
	for _, a := range actions {
		if a.Verb == "failed" {
			r.lastReconcileError = a.Service + ": " + a.Detail
		}
		if strings.Contains(a.Detail, "pull:") {
			r.registryStatus, r.registryError = "failed", a.Detail
		}
		if a.Verb == "started" || a.Verb == "replaced" {
			r.registryStatus, r.registryError = "ok", ""
		}
	}
}

func (r *Reporter) CaptureLogs(ctx context.Context, desired *client.DesiredState) {
	next := make(map[string]string, len(desired.Services))
	for _, svc := range desired.Services {
		text, err := r.docker.Logs(ctx, docker.ContainerName(svc.Name), 160)
		if err == nil && text != "" {
			next[svc.Name] = text
		}
	}
	r.mu.Lock()
	r.logs = next
	r.mu.Unlock()
}

func (r *Reporter) Logs() []client.LogTail {
	r.mu.RLock()
	defer r.mu.RUnlock()
	out := make([]client.LogTail, 0, len(r.logs))
	for service, text := range r.logs {
		out = append(out, client.LogTail{Service: service, Text: text})
	}
	return out
}

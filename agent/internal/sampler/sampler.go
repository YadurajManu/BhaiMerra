// Package sampler reads the host's current resource usage for each heartbeat.
package sampler

import (
	"context"
	"runtime"
	"syscall"
	"time"

	"github.com/fleet-os/fleet-os/agent/internal/capability"
	"github.com/fleet-os/fleet-os/agent/internal/client"
)

// ContainerLister is satisfied by the Docker module. It is an interface so the
// agent still heartbeats correctly on a host where the daemon is down —
// reporting "no containers" is better than reporting nothing at all.
type ContainerLister interface {
	List(ctx context.Context) ([]client.Container, error)
}

type Diagnostics interface {
	Snapshot(context.Context) client.Runtime
	Logs() []client.LogTail
}

type Host struct {
	Version     string
	Containers  ContainerLister
	Diagnostics Diagnostics
	totalRAMMb  int
}

func New(version string, containers ContainerLister, diagnostics Diagnostics) *Host {
	return &Host{
		Version:     version,
		Containers:  containers,
		Diagnostics: diagnostics,
		totalRAMMb:  capability.Detect(version).RAMMb,
	}
}

func (h *Host) Sample(ctx context.Context) (client.Heartbeat, error) {
	hb := client.Heartbeat{
		CPUPct:        loadPercent(),
		RAMUsedMb:     h.usedRAMMb(),
		DiskUsedMb:    usedDiskMb("/"),
		AgentVersion:  h.Version,
		AdvertiseAddr: capability.AdvertiseAddr(),
		Containers:    []client.Container{},
	}
	if h.Diagnostics != nil {
		hb.Runtime, hb.Logs = h.Diagnostics.Snapshot(ctx), h.Diagnostics.Logs()
	}

	if h.Containers != nil {
		listCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
		defer cancel()
		containers, err := h.Containers.List(listCtx)
		if err != nil {
			// A dead Docker daemon is a real condition to report, not a reason
			// to skip the beat — the control plane needs to know the node is
			// alive even when its workloads are not.
			return hb, err
		}
		hb.Containers = containers
	}
	return hb, nil
}

// loadPercent converts 1-minute load average into a rough percentage of
// available CPU. It is an approximation and labelled as one; precise per-core
// accounting is not worth a cgroup reader on the heartbeat path.
func loadPercent() float64 {
	load, err := loadAvg1()
	if err != nil {
		return 0
	}
	pct := (load / float64(runtime.NumCPU())) * 100
	if pct > 100 {
		return 100
	}
	if pct < 0 {
		return 0
	}
	return pct
}

func (h *Host) usedRAMMb() int {
	free := availableRAMMb()
	if free <= 0 || h.totalRAMMb <= 0 {
		return 0
	}
	used := h.totalRAMMb - free
	if used < 0 {
		return 0
	}
	return used
}

func usedDiskMb(path string) int {
	var fs syscall.Statfs_t
	if err := syscall.Statfs(path, &fs); err != nil {
		return 0
	}
	blockSize := uint64(fs.Bsize)
	total := uint64(fs.Blocks) * blockSize
	avail := uint64(fs.Bavail) * blockSize
	if avail > total {
		return 0
	}
	return int((total - avail) / (1024 * 1024))
}

// Package sampler reads the host's current resource usage for each heartbeat.
package sampler

import (
	"context"
	"runtime"
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

	prevNet netMark
}

// Network arrives from the OS as bytes-since-boot, so a rate needs two
// readings and the time between them. Keeping the previous pair on the Host is
// what turns a counter into the kbps a chart can draw — and a counter would
// reset to zero on reboot and draw a cliff.
type netMark struct {
	rx, tx uint64
	at     time.Time
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
		DiskTotalMb:   totalDiskMb("/"),
		Load1:         load1(),
		TempC:         tempC(),
		SwapUsedMb:    swapUsedMb(),
		UptimeSec:     machineUptimeSec(),
		AgentVersion:  h.Version,
		AdvertiseAddr: capability.AdvertiseAddr(),
		Containers:    []client.Container{},
	}
	hb.NetRxKbps, hb.NetTxKbps = h.sampleNet()
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

// load1 is the raw one-minute load average. loadPercent normalises it against
// core count for the CPU gauge; this is the unnormalised figure, because a load
// of 12 on 4 cores and 12 on 32 cores are different situations that the
// percentage flattens into the same number.
func load1() float64 {
	v, err := loadAvg1()
	if err != nil {
		return 0
	}
	return v
}

// sampleNet converts the OS byte counters into a rate.
//
// Returns zero on the first call, because a rate needs two readings and there
// is no honest number to report from one. Also returns zero when the counters
// go backwards, which happens on reboot and on interface churn - a negative
// delta would otherwise draw a spike that never happened.
func (h *Host) sampleNet() (rxKbps, txKbps int) {
	rx, tx := netCounters()
	now := time.Now()
	prev := h.prevNet
	h.prevNet = netMark{rx: rx, tx: tx, at: now}

	if prev.at.IsZero() || rx < prev.rx || tx < prev.tx {
		return 0, 0
	}
	secs := now.Sub(prev.at).Seconds()
	if secs <= 0 {
		return 0, 0
	}
	return int(float64(rx-prev.rx) / secs / 1024), int(float64(tx-prev.tx) / secs / 1024)
}

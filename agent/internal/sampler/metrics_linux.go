//go:build linux

package sampler

import (
	"bufio"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// Extra host metrics, all read from /proc and /sys so the agent stays a single
// static binary with no libc dependency and no external tools to shell out to.
//
// Every one of these returns a zero value rather than an error when the file is
// missing or unreadable. A container without /sys mounted, a kernel without a
// thermal zone, a locked-down host: none of those are reasons to fail a
// heartbeat, and the control plane already treats every field as optional.

// netCounters returns total bytes received and transmitted across every real
// interface since boot.
//
// Loopback is excluded because it double-counts container traffic that never
// left the machine, and docker/veth/bridge interfaces are excluded because they
// count the same packet again on its way to a container. What is left is the
// traffic that actually crossed the network.
func netCounters() (rx, tx uint64) {
	f, err := os.Open("/proc/net/dev")
	if err != nil {
		return 0, 0
	}
	defer f.Close()

	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := sc.Text()
		colon := strings.IndexByte(line, ':')
		if colon < 0 {
			continue // the two header lines
		}
		name := strings.TrimSpace(line[:colon])
		if name == "lo" || strings.HasPrefix(name, "veth") ||
			strings.HasPrefix(name, "docker") || strings.HasPrefix(name, "br-") {
			continue
		}
		fields := strings.Fields(line[colon+1:])
		if len(fields) < 9 {
			continue
		}
		r, _ := strconv.ParseUint(fields[0], 10, 64)
		t, _ := strconv.ParseUint(fields[8], 10, 64)
		rx += r
		tx += t
	}
	return rx, tx
}

// tempC reports the hottest thermal zone in degrees Celsius.
//
// The hottest rather than the first: a Raspberry Pi exposes several zones and
// the one that throttles is not reliably zone 0. Values arrive in millidegrees.
func tempC() float64 {
	zones, err := filepath.Glob("/sys/class/thermal/thermal_zone*/temp")
	if err != nil {
		return 0
	}
	var hottest float64
	for _, z := range zones {
		b, err := os.ReadFile(z)
		if err != nil {
			continue
		}
		milli, err := strconv.ParseFloat(strings.TrimSpace(string(b)), 64)
		if err != nil {
			continue
		}
		c := milli / 1000
		// Some zones report nonsense when a sensor is absent.
		if c > 0 && c < 150 && c > hottest {
			hottest = c
		}
	}
	return hottest
}

func swapUsedMb() int {
	f, err := os.Open("/proc/meminfo")
	if err != nil {
		return 0
	}
	defer f.Close()

	var total, free uint64
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		fields := strings.Fields(sc.Text())
		if len(fields) < 2 {
			continue
		}
		v, _ := strconv.ParseUint(fields[1], 10, 64) // kB
		switch fields[0] {
		case "SwapTotal:":
			total = v
		case "SwapFree:":
			free = v
		}
	}
	if total < free {
		return 0
	}
	return int((total - free) / 1024)
}

func machineUptimeSec() int {
	b, err := os.ReadFile("/proc/uptime")
	if err != nil {
		return 0
	}
	fields := strings.Fields(string(b))
	if len(fields) == 0 {
		return 0
	}
	secs, err := strconv.ParseFloat(fields[0], 64)
	if err != nil {
		return 0
	}
	return int(secs)
}

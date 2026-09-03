//go:build darwin

package sampler

import (
	"os/exec"
	"strconv"
	"strings"
	"time"
)

// macOS has no /proc, and the syscalls for these live behind cgo. The agent is
// built CGO_ENABLED=0 so it stays a single static binary, which leaves sysctl —
// a tool present on every Mac since forever.

func sysctl(key string) string {
	out, err := exec.Command("/usr/sbin/sysctl", "-n", key).Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(out))
}

// netCounters sums bytes in and out across every physical interface.
//
// netstat rather than sysctl: the counters are per-interface and netstat is the
// documented way to read them. -b gives bytes, -n skips DNS resolution that
// would otherwise block for seconds on a bad network.
func netCounters() (rx, tx uint64) {
	out, err := exec.Command("/usr/sbin/netstat", "-ibn").Output()
	if err != nil {
		return 0, 0
	}
	seen := map[string]bool{}
	for _, line := range strings.Split(string(out), "\n")[1:] {
		f := strings.Fields(line)
		if len(f) < 10 {
			continue
		}
		name := f[0]
		// One row per address family per interface; count each interface once.
		if seen[name] || name == "lo0" || strings.HasPrefix(name, "utun") ||
			strings.HasPrefix(name, "bridge") || strings.HasPrefix(name, "awdl") {
			continue
		}
		seen[name] = true
		// Counted from the end because the Address column is absent on <Link#>
		// rows, so the field count varies between 10 and 11. From the right the
		// layout is stable: ... Ibytes Opkts Oerrs Obytes Coll.
		r, err1 := strconv.ParseUint(f[len(f)-5], 10, 64)
		t, err2 := strconv.ParseUint(f[len(f)-2], 10, 64)
		if err1 == nil && err2 == nil {
			rx += r
			tx += t
		}
	}
	return rx, tx
}

// No temperature. Reading the SMC needs a private framework and cgo, and a
// wrong number is worse than an absent one — the control plane treats this as
// optional precisely so a platform can decline.
func tempC() float64 { return 0 }

func swapUsedMb() int {
	// "total = 2048.00M  used = 12.00M  free = 2036.00M"
	fields := strings.Fields(sysctl("vm.swapusage"))
	for i, f := range fields {
		if f == "used" && i+2 < len(fields) {
			v, err := strconv.ParseFloat(strings.TrimSuffix(fields[i+2], "M"), 64)
			if err != nil {
				return 0
			}
			return int(v)
		}
	}
	return 0
}

func machineUptimeSec() int {
	// "{ sec = 1788400000, usec = 123 }"
	raw := sysctl("kern.boottime")
	i := strings.Index(raw, "sec = ")
	if i < 0 {
		return 0
	}
	rest := raw[i+6:]
	end := strings.IndexAny(rest, ",}")
	if end < 0 {
		return 0
	}
	boot, err := strconv.ParseInt(strings.TrimSpace(rest[:end]), 10, 64)
	if err != nil || boot <= 0 {
		return 0
	}
	return int(time.Now().Unix() - boot)
}

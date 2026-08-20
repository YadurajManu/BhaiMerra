//go:build darwin

package capability

import (
	"os/exec"
	"strconv"
	"strings"
)

// macOS is supported as a "dev node" for local testing (PRD 7.1), not as a
// production target, so shelling out to sysctl is acceptable here in a way it
// would not be on the hot path of a Pi.
func totalRAMMb() int {
	out, err := exec.Command("sysctl", "-n", "hw.memsize").Output()
	if err != nil {
		return 0
	}
	bytes, err := strconv.ParseUint(strings.TrimSpace(string(out)), 10, 64)
	if err != nil {
		return 0
	}
	return int(bytes / (1024 * 1024))
}

// Apple Silicon always has an integrated GPU, but nothing in the container
// runtime can pass it through, so reporting true would cause the scheduler to
// place GPU workloads that then cannot run.
func hasGPU() bool {
	return false
}

//go:build linux

package capability

import (
	"bufio"
	"os"
	"strconv"
	"strings"
)

func totalRAMMb() int {
	f, err := os.Open("/proc/meminfo")
	if err != nil {
		return 0
	}
	defer f.Close()

	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		line := scanner.Text()
		if !strings.HasPrefix(line, "MemTotal:") {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) < 2 {
			return 0
		}
		kb, err := strconv.Atoi(fields[1]) // MemTotal is reported in kB
		if err != nil {
			return 0
		}
		return kb / 1024
	}
	return 0
}

// hasGPU looks for the device nodes an actual workload would need. Presence
// of a driver directory is not enough — a container needs the device.
func hasGPU() bool {
	for _, path := range []string{"/dev/nvidia0", "/dev/nvidiactl", "/dev/dri/renderD128"} {
		if _, err := os.Stat(path); err == nil {
			return true
		}
	}
	return false
}

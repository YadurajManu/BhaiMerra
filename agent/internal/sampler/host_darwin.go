//go:build darwin

package sampler

import (
	"os/exec"
	"strconv"
	"strings"
)

func loadAvg1() (float64, error) {
	out, err := exec.Command("sysctl", "-n", "vm.loadavg").Output()
	if err != nil {
		return 0, err
	}
	// sysctl prints "{ 2.15 2.40 2.52 }"
	fields := strings.Fields(strings.Trim(strings.TrimSpace(string(out)), "{}"))
	if len(fields) == 0 {
		return 0, nil
	}
	return strconv.ParseFloat(fields[0], 64)
}

func availableRAMMb() int {
	out, err := exec.Command("vm_stat").Output()
	if err != nil {
		return 0
	}
	pageSize := 4096
	var freePages, inactivePages int
	for _, line := range strings.Split(string(out), "\n") {
		parts := strings.SplitN(line, ":", 2)
		if len(parts) != 2 {
			continue
		}
		value, err := strconv.Atoi(strings.TrimSpace(strings.Trim(parts[1], ".")))
		if err != nil {
			continue
		}
		switch strings.TrimSpace(parts[0]) {
		case "Pages free":
			freePages = value
		case "Pages inactive":
			inactivePages = value
		}
	}
	return (freePages + inactivePages) * pageSize / (1024 * 1024)
}

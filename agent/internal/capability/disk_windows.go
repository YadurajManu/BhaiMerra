//go:build windows

package capability

import (
	"os"

	"golang.org/x/sys/windows"
)

// Free space on the system volume.
//
// This used to return a hardcoded 50000. The scheduler weighs free disk when
// deciding where a service can run, so every Windows node claimed the same
// ~49 GB regardless of whether it had a terabyte spare or was completely full.
//
// freeToCaller rather than the volume's total free: it honours per-user quotas,
// and what matters for placement is what this agent can actually write.
func freeDiskMb(path string) int {
	target := path
	if target == "" || target == "/" || target == "\\" {
		if sys := os.Getenv("SystemDrive"); sys != "" {
			target = sys + `\`
		} else {
			target = `C:\`
		}
	}

	p, err := windows.UTF16PtrFromString(target)
	if err != nil {
		return 0
	}
	var freeToCaller, total, totalFree uint64
	if err := windows.GetDiskFreeSpaceEx(p, &freeToCaller, &total, &totalFree); err != nil {
		return 0
	}
	return int(freeToCaller / (1024 * 1024))
}

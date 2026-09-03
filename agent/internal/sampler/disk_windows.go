//go:build windows

package sampler

import (
	"os"

	"golang.org/x/sys/windows"
)

// Real numbers, from the Windows API.
//
// This used to return a hardcoded 10000. A Windows node therefore reported the
// same invented disk usage forever: the dashboard drew it, the scheduler
// weighed placement against it, and nothing about it was true.
//
// GetDiskFreeSpaceEx reports two different "free" values. freeToCaller honours
// per-user quotas and is what an application can actually write; totalFree is
// the volume's own free space. Used is derived from totalFree, because a quota
// does not change how full the disk is.
func diskBytes(path string) (total, freeToCaller, totalFree uint64, ok bool) {
	p, err := windows.UTF16PtrFromString(volumeFor(path))
	if err != nil {
		return 0, 0, 0, false
	}
	if err := windows.GetDiskFreeSpaceEx(p, &freeToCaller, &total, &totalFree); err != nil {
		return 0, 0, 0, false
	}
	return total, freeToCaller, totalFree, true
}

// The rest of the agent passes "/" because that is the Unix root. On Windows
// that is not a volume, so map it to whichever drive the system is installed
// on rather than assuming C:.
func volumeFor(path string) string {
	if path == "" || path == "/" || path == "\\" {
		if sys := os.Getenv("SystemDrive"); sys != "" {
			return sys + `\`
		}
		return `C:\`
	}
	return path
}

func usedDiskMb(path string) int {
	total, _, totalFree, ok := diskBytes(path)
	if !ok || totalFree > total {
		return 0
	}
	return int((total - totalFree) / (1024 * 1024))
}

func totalDiskMb(path string) int {
	total, _, _, ok := diskBytes(path)
	if !ok {
		return 0
	}
	return int(total / (1024 * 1024))
}

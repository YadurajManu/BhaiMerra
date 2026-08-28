//go:build !windows

package capability

import "syscall"

func freeDiskMb(path string) int {
	var fs syscall.Statfs_t
	if err := syscall.Statfs(path, &fs); err != nil {
		return 0
	}
	return int((uint64(fs.Bavail) * uint64(fs.Bsize)) / (1024 * 1024))
}

//go:build !windows

package sampler

import "syscall"

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

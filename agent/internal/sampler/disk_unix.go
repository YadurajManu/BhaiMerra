//go:build !windows

package sampler

import "syscall"

// statfs returns total and available bytes for the filesystem holding path.
// Both numbers come from one call because asking twice can straddle a write
// and produce a used figure larger than the total.
func statfs(path string) (total, avail uint64, ok bool) {
	var fs syscall.Statfs_t
	if err := syscall.Statfs(path, &fs); err != nil {
		return 0, 0, false
	}
	blockSize := uint64(fs.Bsize)
	return uint64(fs.Blocks) * blockSize, uint64(fs.Bavail) * blockSize, true
}

func usedDiskMb(path string) int {
	total, avail, ok := statfs(path)
	if !ok || avail > total {
		return 0
	}
	return int((total - avail) / (1024 * 1024))
}

// totalDiskMb is the capacity of the filesystem, not what is left on it.
//
// The dashboard needs this to render "used of total". It previously divided by
// the *free* figure the capability report carries, which is why a disk with
// more used than free rendered as impossible.
func totalDiskMb(path string) int {
	total, _, ok := statfs(path)
	if !ok {
		return 0
	}
	return int(total / (1024 * 1024))
}

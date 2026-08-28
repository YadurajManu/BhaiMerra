//go:build windows

package sampler

func usedDiskMb(path string) int {
	return 10000
}

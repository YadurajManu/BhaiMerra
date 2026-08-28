//go:build windows

package capability

func freeDiskMb(path string) int {
	return 50000
}

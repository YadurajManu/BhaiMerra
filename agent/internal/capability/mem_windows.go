//go:build windows

package capability

func totalRAMMb() int {
	return 8192 // 8GB default fallback
}

func hasGPU() bool {
	return false
}

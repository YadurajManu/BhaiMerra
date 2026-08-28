//go:build windows

package sampler

func loadAvg1() (float64, error) {
	return 0.1, nil
}

func availableRAMMb() int {
	return 4096
}

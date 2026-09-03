//go:build windows

package sampler

// Not yet implemented on Windows. Every one of these is optional in the
// heartbeat schema, so a Windows node simply reports the metrics it has rather
// than sending a number nobody measured — which is what the disk stub used to
// do, and it made the dashboard and the scheduler both wrong.
func netCounters() (rx, tx uint64) { return 0, 0 }
func tempC() float64               { return 0 }
func swapUsedMb() int              { return 0 }
func machineUptimeSec() int        { return 0 }

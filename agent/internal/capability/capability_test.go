package capability

import (
	"runtime"
	"strings"
	"testing"
)

func TestNormalizeArch(t *testing.T) {
	cases := map[string]string{
		"arm64": "arm64",
		"arm":   "armv7", // Go calls it arm; the control plane builds armv7
		"amd64": "amd64",
		"386":   "386", // unknown passes through so the server can reject it clearly
	}
	for goarch, want := range cases {
		if got := NormalizeArch(goarch); got != want {
			t.Errorf("NormalizeArch(%q) = %q, want %q", goarch, got, want)
		}
	}
}

func TestDetectReportsUsableValues(t *testing.T) {
	report := Detect("0.1.0-test")

	if report.CPUCores < 1 {
		t.Errorf("cpu_cores = %d, want at least 1", report.CPUCores)
	}
	if report.RAMMb < 64 {
		// The control plane's schema rejects anything under 64MB, so a
		// detection failure here would make the node unregisterable.
		t.Errorf("ram_mb = %d, want at least 64 (detection likely failed)", report.RAMMb)
	}
	if report.DiskMb < 0 {
		t.Errorf("disk_mb = %d, want non-negative", report.DiskMb)
	}
	if report.Arch != NormalizeArch(runtime.GOARCH) {
		t.Errorf("arch = %q, want %q", report.Arch, NormalizeArch(runtime.GOARCH))
	}
	if report.OS != runtime.GOOS {
		t.Errorf("os = %q, want %q", report.OS, runtime.GOOS)
	}
	if report.AgentVersion != "0.1.0-test" {
		t.Errorf("agent_version = %q, want the version passed in", report.AgentVersion)
	}
}

func TestDetectStripsMDNSSuffix(t *testing.T) {
	// A Pi commonly reports "raspberrypi.local"; the node name should not
	// carry the mDNS suffix into the dashboard.
	if strings.HasSuffix(Detect("test").Hostname, ".local") {
		t.Error("hostname should have .local stripped")
	}
}

func TestConnectivityIsHonestWhenUnknown(t *testing.T) {
	// Guessing wrong here makes the control plane pick the wrong ingress
	// path, so "unknown" is the correct answer until the mesh module lands.
	if got := detectConnectivity(); got != "unknown" && got != "direct" && got != "nat" {
		t.Errorf("connectivity = %q, want one of unknown|direct|nat", got)
	}
}

// Package capability answers the question the scheduler needs before it can
// place anything: what is this machine actually able to run (PRD FR-2)?
//
// Everything here is best-effort and must never prevent an agent from
// starting. A node that reports conservative numbers still gets scheduled;
// a node that refuses to register is invisible.
package capability

import (
	"net"
	"os"
	"runtime"
	"strings"
	"syscall"
)

// Report is the payload sent to POST /agent/register. Field names are the
// wire contract with the control plane — changing one is a breaking change.
type Report struct {
	Arch         string `json:"arch"`
	OS           string `json:"os"`
	CPUCores     int    `json:"cpu_cores"`
	RAMMb        int    `json:"ram_mb"`
	DiskMb       int    `json:"disk_mb"`
	GPU          bool   `json:"gpu"`
	Connectivity string `json:"connectivity"`
	Hostname     string `json:"hostname,omitempty"`
	AgentVersion string `json:"agent_version,omitempty"`
	// AdvertiseAddr is where the control plane's ingress can reach this node.
	// Until the mesh exists this must be directly routable from the control
	// plane, which is true on a LAN and not true through NAT.
	AdvertiseAddr string `json:"advertise_addr,omitempty"`
}

// NormalizeArch maps Go's GOARCH onto the three architectures the control
// plane builds for. Anything else is reported verbatim so the control plane
// can reject it with a clear message rather than silently mis-scheduling.
func NormalizeArch(goarch string) string {
	switch goarch {
	case "arm64":
		return "arm64"
	case "arm":
		return "armv7"
	case "amd64":
		return "amd64"
	default:
		return goarch
	}
}

// Detect gathers everything the scheduler filters on.
func Detect(version string) Report {
	host, err := os.Hostname()
	if err != nil {
		host = ""
	}
	// Strip the mDNS suffix so "pi-5.local" registers as "pi-5".
	host = strings.TrimSuffix(host, ".local")

	return Report{
		Arch:          NormalizeArch(runtime.GOARCH),
		OS:            runtime.GOOS,
		CPUCores:      runtime.NumCPU(),
		RAMMb:         totalRAMMb(),
		DiskMb:        freeDiskMb("/"),
		GPU:           hasGPU(),
		Connectivity:  detectConnectivity(),
		Hostname:      host,
		AgentVersion:  version,
		AdvertiseAddr: AdvertiseAddr(),
	}
}

// AdvertiseAddr picks the address other machines should use to reach this one.
//
// FLEET_ADVERTISE_ADDR wins, because only the operator knows about port
// forwards and split-horizon DNS. Otherwise it is the local address that
// carries the default route — not a loopback, and not a guess from a list of
// every interface, which on a laptop includes several bridges that go nowhere.
func AdvertiseAddr() string {
	if addr := os.Getenv("FLEET_ADVERTISE_ADDR"); addr != "" {
		return addr
	}
	return outboundIP()
}

// outboundIP asks the kernel which source address it would use to reach a
// public address. No packet is sent — a UDP socket has no handshake.
func outboundIP() string {
	conn, err := net.Dial("udp", "203.0.113.1:80") // TEST-NET-3, never routed
	if err != nil {
		return ""
	}
	defer conn.Close()
	if addr, ok := conn.LocalAddr().(*net.UDPAddr); ok {
		return addr.IP.String()
	}
	return ""
}

// freeDiskMb reports space available to an unprivileged process, not raw
// capacity — the scheduler cares about what a container can actually use.
func freeDiskMb(path string) int {
	var fs syscall.Statfs_t
	if err := syscall.Statfs(path, &fs); err != nil {
		return 0
	}
	return int((uint64(fs.Bavail) * uint64(fs.Bsize)) / (1024 * 1024))
}

// detectConnectivity is a placeholder until the mesh module lands in Phase 4.
// It reports "unknown" rather than guessing: a wrong answer here would make
// the control plane choose the wrong ingress path.
func detectConnectivity() string {
	return "unknown"
}

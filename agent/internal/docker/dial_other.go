//go:build !windows

package docker

import (
	"context"
	"fmt"
	"net"
	"runtime"
)

// defaultEndpoints for Linux and macOS: the socket the daemon has always used.
func defaultEndpoints() []endpoint {
	return []endpoint{{"unix", "/var/run/docker.sock"}}
}

// dialEndpoint opens one connection to the daemon.
//
// A named pipe can only be reached with the Windows API, so asking for one here
// is a configuration mistake rather than a connection failure — say which,
// because "connection refused" would send someone looking for a daemon that
// was never the problem.
func dialEndpoint(ctx context.Context, e endpoint) (net.Conn, error) {
	if e.network == "npipe" {
		return nil, fmt.Errorf(
			"DOCKER_HOST names a named pipe (%s), which is a Windows transport; this agent is running on %s",
			e.addr, runtime.GOOS)
	}
	return (&net.Dialer{}).DialContext(ctx, e.network, e.addr)
}

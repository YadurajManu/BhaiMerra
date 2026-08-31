//go:build windows

package docker

import (
	"context"
	"net"

	"github.com/Microsoft/go-winio"
)

// defaultEndpoints for Windows.
//
// The named pipe first, because that is what Docker Desktop serves by default
// and requires nothing of the operator. TCP second, for machines where someone
// has ticked "Expose daemon on tcp://localhost:2375 without TLS" — that setting
// hands unauthenticated root-equivalent control of the machine to anything that
// can reach the port, so it is a fallback and never the recommendation.
func defaultEndpoints() []endpoint {
	return []endpoint{
		{"npipe", windowsPipe},
		{"tcp", "127.0.0.1:2375"},
	}
}

// dialEndpoint opens one connection to the daemon.
//
// Named pipes are not sockets and Go's net package cannot dial them at all,
// which is why this file exists: without it a Windows agent has no working
// transport, falls through to a unix socket path that cannot exist, and
// reports a confusing error about a dead network.
func dialEndpoint(ctx context.Context, e endpoint) (net.Conn, error) {
	if e.network == "npipe" {
		// DialPipeContext honours the context deadline, so a daemon that is
		// starting up fails the probe rather than hanging it.
		return winio.DialPipeContext(ctx, e.addr)
	}
	return (&net.Dialer{}).DialContext(ctx, e.network, e.addr)
}

package docker

import (
	"fmt"
	"strings"
)

// endpoint is one place the Docker Engine API might be listening.
//
// Three transports matter, and which ones exist depends on the platform: a
// unix socket on Linux and macOS, a named pipe on Windows, and TCP anywhere
// somebody has deliberately exposed the daemon on a port.
type endpoint struct {
	network string // "unix" | "npipe" | "tcp"
	addr    string
}

func (e endpoint) String() string { return e.network + "://" + e.addr }

// The pipe Docker Desktop serves the Engine API on. Docker's own CLI uses the
// same default.
const windowsPipe = `\\.\pipe\docker_engine`

// parseDockerHost turns a DOCKER_HOST value into an endpoint.
//
// Returns false for anything unrecognised, so the caller falls back to the
// platform default rather than silently trying to dial a scheme it does not
// speak. ssh:// is deliberately unsupported: it would mean shelling out, and
// an agent that needs a remote daemon is a different product.
func parseDockerHost(value string) (endpoint, bool) {
	value = strings.TrimSpace(value)
	if value == "" {
		return endpoint{}, false
	}

	switch {
	case strings.HasPrefix(value, "unix://"):
		return endpoint{"unix", strings.TrimPrefix(value, "unix://")}, true

	case strings.HasPrefix(value, "npipe://"):
		// Docker writes these with forward slashes — npipe:////./pipe/name —
		// but Windows only opens the backslash form.
		path := strings.TrimPrefix(value, "npipe://")
		return endpoint{"npipe", strings.ReplaceAll(path, "/", `\`)}, true

	case strings.HasPrefix(value, "tcp://"):
		return endpoint{"tcp", strings.TrimPrefix(value, "tcp://")}, true

	case strings.HasPrefix(value, "http://"):
		return endpoint{"tcp", strings.TrimPrefix(value, "http://")}, true

	// A bare path is a socket. Anything else is not something to guess at.
	case strings.HasPrefix(value, "/"):
		return endpoint{"unix", value}, true
	}

	return endpoint{}, false
}

// endpointsFor decides where to look for the daemon.
//
// An explicit DOCKER_HOST wins and is the only candidate — if someone named a
// daemon, quietly falling back to a different one is worse than failing.
func endpointsFor(dockerHost string) []endpoint {
	if e, ok := parseDockerHost(dockerHost); ok {
		return []endpoint{e}
	}
	return defaultEndpoints()
}

// unreachable builds the error when nothing answered.
//
// It names every transport that was tried. The previous version reported
// `dial unix /var/run/docker.sock` on Windows machines that have no unix
// sockets at all, which sent people looking for a file that could never exist.
func unreachable(tried []endpoint, last error) error {
	names := make([]string, 0, len(tried))
	for _, e := range tried {
		names = append(names, e.String())
	}
	return fmt.Errorf("no Docker daemon answered on %s: %w", strings.Join(names, ", "), last)
}

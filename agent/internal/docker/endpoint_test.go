package docker

import (
	"errors"
	"runtime"
	"strings"
	"testing"
)

func TestParseDockerHost(t *testing.T) {
	cases := []struct {
		in      string
		network string
		addr    string
		ok      bool
	}{
		{"unix:///var/run/docker.sock", "unix", "/var/run/docker.sock", true},
		{"tcp://127.0.0.1:2375", "tcp", "127.0.0.1:2375", true},
		{"http://localhost:2375", "tcp", "localhost:2375", true},
		{"/var/run/docker.sock", "unix", "/var/run/docker.sock", true},

		// Docker writes pipe URLs with forward slashes; Windows only opens the
		// backslash form, so the conversion has to happen here.
		{`npipe:////./pipe/docker_engine`, "npipe", `\\.\pipe\docker_engine`, true},

		// Unrecognised schemes fall back to the platform default rather than
		// being guessed at. ssh:// in particular would mean shelling out.
		{"ssh://user@host", "", "", false},
		{"", "", "", false},
		{"   ", "", "", false},
	}

	for _, c := range cases {
		got, ok := parseDockerHost(c.in)
		if ok != c.ok {
			t.Errorf("parseDockerHost(%q) ok = %v, want %v", c.in, ok, c.ok)
			continue
		}
		if !ok {
			continue
		}
		if got.network != c.network || got.addr != c.addr {
			t.Errorf("parseDockerHost(%q) = %s://%s, want %s://%s",
				c.in, got.network, got.addr, c.network, c.addr)
		}
	}
}

func TestAnExplicitDockerHostIsTheOnlyCandidate(t *testing.T) {
	// Someone who names a daemon means that daemon. Falling back to a
	// different one on failure would connect to the wrong machine's Docker and
	// look like it worked.
	got := endpointsFor("tcp://10.0.0.5:2375")
	if len(got) != 1 {
		t.Fatalf("expected exactly one endpoint, got %v", got)
	}
	if got[0].network != "tcp" || got[0].addr != "10.0.0.5:2375" {
		t.Errorf("endpoint = %s, want tcp://10.0.0.5:2375", got[0])
	}
}

func TestAnUnparseableDockerHostFallsBackToTheDefault(t *testing.T) {
	got := endpointsFor("ssh://user@host")
	want := defaultEndpoints()
	if len(got) != len(want) || got[0] != want[0] {
		t.Errorf("endpoints = %v, want the platform default %v", got, want)
	}
}

func TestTheDefaultEndpointsSuitThisPlatform(t *testing.T) {
	got := defaultEndpoints()
	if len(got) == 0 {
		t.Fatal("no default endpoint for this platform")
	}

	if runtime.GOOS == "windows" {
		// The named pipe has to be first: it is what Docker Desktop serves out
		// of the box, and the TCP alternative requires the operator to expose
		// the daemon unauthenticated on a port.
		if got[0].network != "npipe" {
			t.Errorf("first endpoint on Windows = %s, want the named pipe", got[0])
		}
		return
	}

	if got[0].network != "unix" || got[0].addr != "/var/run/docker.sock" {
		t.Errorf("first endpoint = %s, want unix:///var/run/docker.sock", got[0])
	}
	// A unix agent must never look for a pipe it cannot open.
	for _, e := range got {
		if e.network == "npipe" {
			t.Errorf("%s is not reachable from %s", e, runtime.GOOS)
		}
	}
}

func TestUnreachableNamesEveryTransportTried(t *testing.T) {
	// The bug this replaces: a Windows agent reported
	// `dial unix /var/run/docker.sock`, sending people to look for a file that
	// cannot exist on their machine. The error has to say where it actually
	// looked.
	tried := []endpoint{{"npipe", windowsPipe}, {"tcp", "127.0.0.1:2375"}}
	err := unreachable(tried, errors.New("the pipe does not exist"))

	msg := err.Error()
	for _, want := range []string{"npipe", "docker_engine", "tcp", "127.0.0.1:2375"} {
		if !strings.Contains(msg, want) {
			t.Errorf("error does not mention %q: %s", want, msg)
		}
	}
	// And the underlying cause survives, or the reason is lost.
	if !strings.Contains(msg, "the pipe does not exist") {
		t.Errorf("error dropped the underlying cause: %s", msg)
	}
}

func TestClientRecordsWhereItLooked(t *testing.T) {
	c := New("")
	if len(c.endpoints) == 0 {
		t.Fatal("client has no endpoints to dial")
	}
	if c.host == "" {
		t.Error("client does not record where it looked, which diagnostics report")
	}
}

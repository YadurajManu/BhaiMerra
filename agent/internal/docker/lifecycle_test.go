package docker

import "testing"

func TestSplitTag(t *testing.T) {
	cases := []struct {
		image, wantRef, wantTag string
	}{
		{"nginx", "nginx", "latest"},
		{"nginx:1.27", "nginx", "1.27"},
		{"ghcr.io/you/app:v2", "ghcr.io/you/app", "v2"},
		// A registry port must not be mistaken for a tag — this is the case
		// that breaks naive splitting, and it is exactly what a self-hosted
		// registry looks like.
		{"localhost:5001/web", "localhost:5001/web", "latest"},
		{"localhost:5001/web:4f1c9ae", "localhost:5001/web", "4f1c9ae"},
	}
	for _, c := range cases {
		ref, tag := splitTag(c.image)
		if ref != c.wantRef || tag != c.wantTag {
			t.Errorf("splitTag(%q) = (%q, %q), want (%q, %q)", c.image, ref, tag, c.wantRef, c.wantTag)
		}
	}
}

func TestContainerNameIsDeterministic(t *testing.T) {
	// Reconciliation finds what it created by name after a restart, without
	// keeping its own index — so this must not drift.
	if got := ContainerName("img-proxy"); got != "fleet-img-proxy" {
		t.Errorf("ContainerName = %q, want fleet-img-proxy", got)
	}
	if ContainerName("web") != ContainerName("web") {
		t.Error("ContainerName is not stable")
	}
}

func TestDemultiplexStripsStreamHeaders(t *testing.T) {
	// Docker frames log output as [stream, 0,0,0, size(4 bytes)] + payload.
	frame := func(payload string) []byte {
		n := len(payload)
		return append([]byte{1, 0, 0, 0, byte(n >> 24), byte(n >> 16), byte(n >> 8), byte(n)}, payload...)
	}
	raw := append(frame("hello\n"), frame("world\n")...)
	if got := demultiplex(raw); got != "hello\nworld\n" {
		t.Errorf("demultiplex = %q, want %q", got, "hello\nworld\n")
	}
}

func TestDemultiplexPassesThroughUnframedOutput(t *testing.T) {
	// A TTY container writes raw bytes with no header; mangling that would
	// make logs unreadable for exactly the containers people run interactively.
	raw := []byte("plain tty output with no framing at all")
	if got := demultiplex(raw); got != string(raw) {
		t.Errorf("demultiplex mangled unframed output: %q", got)
	}
}

func TestIsNotFoundUnwraps(t *testing.T) {
	if !IsNotFound(&Error{StatusCode: 404}) {
		t.Error("404 should be reported as not found")
	}
	if IsNotFound(&Error{StatusCode: 500}) {
		t.Error("500 is a real failure, not a missing container")
	}
	if IsNotFound(nil) {
		t.Error("nil is not a not-found error")
	}
}

func TestCompareVersions(t *testing.T) {
	cases := []struct {
		a, b string
		want int
	}{
		// The case that matters: string comparison would put 1.9 above 1.44.
		{"1.9", "1.44", -1},
		{"1.44", "1.9", 1},
		{"1.44", "1.44", 0},
		{"1.43", "1.44", -1},
		{"1.51", "1.44", 1},
		{"1", "1.0", 0},
	}
	for _, c := range cases {
		if got := compareVersions(c.a, c.b); got != c.want {
			t.Errorf("compareVersions(%q, %q) = %d, want %d", c.a, c.b, got, c.want)
		}
	}
}

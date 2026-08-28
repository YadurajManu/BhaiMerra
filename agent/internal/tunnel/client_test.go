package tunnel

import (
	"bytes"
	"encoding/base64"
	"io"
	"log/slog"
	"net/http"
	"testing"
)

// captureTransport stands in for the container, recording the request the agent
// actually constructed. Swapping the RoundTripper rather than starting a real
// listener keeps the test hermetic and inspects the outgoing request directly —
// which is where the Host bug lived, since Go rewrites that field on the way out.
type captureTransport struct {
	got *http.Request
}

func (c *captureTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	c.got = r
	return &http.Response{
		StatusCode: http.StatusNoContent,
		Header:     http.Header{},
		Body:       io.NopCloser(bytes.NewReader(nil)),
		Request:    r,
	}, nil
}

// newTestClient builds a Client with no websocket attached, so sendResponse
// returns early and handleHttpRequest can be exercised without a control plane.
func newTestClient() (*Client, *captureTransport) {
	c := New("http://localhost:8080", "tok", slog.New(slog.NewTextHandler(io.Discard, nil)))
	tr := &captureTransport{}
	c.httpClient = &http.Client{Transport: tr}
	return c, tr
}

func TestForwardedHostReachesTheContainer(t *testing.T) {
	// The bug this pins: Go builds the outgoing Host from the URL and ignores
	// Header.Set("Host"), so a container behind a tunnel used to be told its own
	// loopback address was the hostname the client had asked for.
	c, tr := newTestClient()

	c.handleHttpRequest(&TunnelRequest{
		Type:   "http_request",
		ID:     "req-1",
		Port:   32768,
		Method: "GET",
		Path:   "/dashboard",
		Headers: map[string]string{
			"Host":              "web-homelab-abc123.fleetos.app",
			"X-Forwarded-For":   "198.51.100.4, 203.0.113.9",
			"X-Forwarded-Proto": "https",
			"X-Fleet-Service":   "web",
		},
	})

	if tr.got == nil {
		t.Fatal("no request reached the transport")
	}
	if tr.got.Host != "web-homelab-abc123.fleetos.app" {
		t.Errorf("Host = %q, want the forwarded hostname, not the loopback address", tr.got.Host)
	}
	// The Host header must not also be set literally, or Go sends both and the
	// container has two conflicting answers.
	if h := tr.got.Header.Get("Host"); h != "" {
		t.Errorf("Host header = %q, want it moved to Request.Host only", h)
	}
	if got := tr.got.Header.Get("X-Forwarded-For"); got != "198.51.100.4, 203.0.113.9" {
		t.Errorf("X-Forwarded-For = %q, want the chain intact", got)
	}
	if got := tr.got.Header.Get("X-Forwarded-Proto"); got != "https" {
		t.Errorf("X-Forwarded-Proto = %q, want https", got)
	}
	if got := tr.got.Header.Get("X-Fleet-Service"); got != "web" {
		t.Errorf("X-Fleet-Service = %q, want web", got)
	}
	if tr.got.URL.Host != "127.0.0.1:32768" {
		t.Errorf("URL host = %q, want the container on loopback", tr.got.URL.Host)
	}
	if tr.got.URL.Path != "/dashboard" {
		t.Errorf("path = %q, want /dashboard", tr.got.URL.Path)
	}
}

func TestRequestBodyIsForwarded(t *testing.T) {
	c, tr := newTestClient()

	c.handleHttpRequest(&TunnelRequest{
		Type:    "http_request",
		ID:      "req-2",
		Port:    32768,
		Method:  "POST",
		Path:    "/submit",
		Headers: map[string]string{"Host": "web.fleetos.app", "Content-Type": "text/plain"},
		Body:    base64.StdEncoding.EncodeToString([]byte("hello from the edge")),
	})

	if tr.got == nil {
		t.Fatal("no request reached the transport")
	}
	if tr.got.Method != "POST" {
		t.Errorf("method = %q, want POST", tr.got.Method)
	}
	body, _ := io.ReadAll(tr.got.Body)
	if string(body) != "hello from the edge" {
		t.Errorf("body = %q, want it forwarded verbatim", body)
	}
}

func TestKeepaliveTimingsAgreeWithTheControlPlane(t *testing.T) {
	// pongWait shorter than the control plane's ping period would tear down a
	// healthy but idle tunnel on a timer. The control plane pings every 25s —
	// PING_PERIOD_MS in control-plane/src/tunnel/registry.ts.
	if pongWait <= pingPeriod {
		t.Errorf("pongWait (%v) must exceed pingPeriod (%v)", pongWait, pingPeriod)
	}
	if pongWait < 2*pingPeriod {
		t.Errorf("pongWait (%v) should tolerate one dropped ping (2 × %v)", pongWait, pingPeriod)
	}
	if dataWriteWait <= writeWait {
		t.Errorf("dataWriteWait (%v) should be more generous than writeWait (%v)", dataWriteWait, writeWait)
	}
}

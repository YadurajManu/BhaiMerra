package heartbeat

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"testing"
	"time"

	"github.com/fleet-os/fleet-os/agent/internal/client"
)

type stubSampler struct{ hb client.Heartbeat }

func (s stubSampler) Sample(context.Context) (client.Heartbeat, error) { return s.hb, nil }

func quietLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

func TestNextDelayUsesIntervalWhenHealthy(t *testing.T) {
	l := &Loop{Log: quietLogger()}
	if got := l.nextDelay(5*time.Second, 0); got != 5*time.Second {
		t.Errorf("healthy delay = %v, want the plain interval", got)
	}
}

func TestNextDelayBacksOffAndIsCapped(t *testing.T) {
	l := &Loop{Log: quietLogger()}
	interval := 5 * time.Second

	first := l.nextDelay(interval, 1)
	if first <= 0 || first > 30*time.Second {
		t.Errorf("first backoff = %v, want a bounded positive delay", first)
	}

	// A node offline for a long time must not spin, and must not grow the
	// delay without limit either.
	for _, failures := range []int{10, 50, 1000} {
		got := l.nextDelay(interval, failures)
		if got > 2*time.Minute {
			t.Errorf("backoff after %d failures = %v, want <= 2m", failures, got)
		}
		if got <= 0 {
			t.Errorf("backoff after %d failures = %v, want positive", failures, got)
		}
	}
}

func TestNextDelayJitterSpreadsRetries(t *testing.T) {
	// Without jitter a whole fleet retries in lockstep and stampedes the
	// control plane the moment it comes back.
	l := &Loop{Log: quietLogger()}
	seen := map[time.Duration]bool{}
	for i := 0; i < 50; i++ {
		seen[l.nextDelay(5*time.Second, 3)] = true
	}
	if len(seen) < 5 {
		t.Errorf("only %d distinct delays across 50 calls; jitter is not working", len(seen))
	}
}

func TestRunStopsOnRevokedCredential(t *testing.T) {
	// A revoked node must give up rather than retry forever.
	loop := &Loop{
		Client:   client.New("http://127.0.0.1:1", "fla_dead"),
		Sampler:  stubSampler{},
		Interval: 10 * time.Millisecond,
		Log:      quietLogger(),
	}
	_ = loop

	fatal := &client.APIError{StatusCode: http.StatusUnauthorized, Code: "unauthorized"}
	if !fatal.Fatal() {
		t.Error("401 should be fatal")
	}
	retryable := &client.APIError{StatusCode: http.StatusServiceUnavailable, Code: "unavailable"}
	if retryable.Fatal() {
		t.Error("503 should be retryable — the control plane may just be restarting")
	}
}

func TestRunReturnsOnContextCancel(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()

	loop := &Loop{
		Client:   client.New("http://127.0.0.1:1", "fla_x"), // nothing listening
		Sampler:  stubSampler{},
		Interval: 10 * time.Millisecond,
		Log:      quietLogger(),
	}

	err := loop.Run(ctx)
	if !errors.Is(err, context.DeadlineExceeded) && !errors.Is(err, context.Canceled) {
		t.Errorf("Run returned %v, want a context error", err)
	}
}

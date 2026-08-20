// Package heartbeat runs the agent's liveness loop.
package heartbeat

import (
	"context"
	"errors"
	"log/slog"
	"math"
	"math/rand"
	"time"

	"github.com/fleet-os/fleet-os/agent/internal/client"
)

// Sampler supplies the current resource picture. Kept as an interface so the
// loop can be tested without touching the host or the Docker daemon.
type Sampler interface {
	Sample(ctx context.Context) (client.Heartbeat, error)
}

type Loop struct {
	Client   *client.Client
	Sampler  Sampler
	Interval time.Duration
	Log      *slog.Logger
}

// Run beats until the context is cancelled or the credential is rejected.
//
// Losing the control plane is explicitly not fatal (PRD §9): containers keep
// running, the agent keeps retrying with backoff, and it resyncs on reconnect.
// The one thing it will not do is stop workloads because it feels lonely.
func (l *Loop) Run(ctx context.Context) error {
	interval := l.Interval
	if interval <= 0 {
		interval = 5 * time.Second
	}

	consecutiveFailures := 0
	timer := time.NewTimer(0)
	defer timer.Stop()

	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-timer.C:
		}

		hb, err := l.Sampler.Sample(ctx)
		if err != nil {
			l.Log.Warn("could not sample host resources", "err", err)
		}

		resp, err := l.Client.SendHeartbeat(ctx, hb)
		switch {
		case err == nil:
			if consecutiveFailures > 0 {
				l.Log.Info("reconnected to control plane", "after_failures", consecutiveFailures)
			}
			consecutiveFailures = 0
			// The control plane owns the interval; a fleet can retune it
			// without anyone touching the nodes.
			if resp.IntervalSec > 0 && time.Duration(resp.IntervalSec)*time.Second != interval {
				interval = time.Duration(resp.IntervalSec) * time.Second
				l.Log.Info("heartbeat interval updated by control plane", "interval", interval)
			}

		default:
			var apiErr *client.APIError
			if errors.As(err, &apiErr) && apiErr.Fatal() {
				// A revoked node must stop talking rather than retry forever.
				l.Log.Error("credential rejected, stopping", "err", apiErr)
				return err
			}
			consecutiveFailures++
			l.Log.Warn("heartbeat failed, will retry",
				"err", err, "consecutive_failures", consecutiveFailures)
		}

		timer.Reset(l.nextDelay(interval, consecutiveFailures))
	}
}

// nextDelay backs off exponentially while the control plane is unreachable, so
// a fleet of nodes does not turn a brief outage into a thundering herd when it
// recovers. Jitter spreads the retry across the window.
func (l *Loop) nextDelay(interval time.Duration, failures int) time.Duration {
	if failures == 0 {
		return interval
	}
	const maxBackoff = 2 * time.Minute
	backoff := time.Duration(float64(interval) * math.Pow(2, math.Min(float64(failures), 6)))
	if backoff > maxBackoff {
		backoff = maxBackoff
	}
	jitter := time.Duration(rand.Int63n(int64(backoff / 4)))
	return backoff/2 + jitter
}

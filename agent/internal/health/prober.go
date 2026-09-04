// Package health decides whether a service is serving, by asking it from the
// node rather than from inside its own container.
//
// Docker's HEALTHCHECK runs the probe *in* the container, so the check can only
// work if the image happens to contain an HTTP client. Fleet used to shell out
// to `wget || curl || exit 1`, which quietly makes every user's base image part
// of Fleet's contract. node:20-bookworm-slim ships neither, and the result was
// the worst possible failure: the container ran, served traffic correctly, and
// reported unhealthy for ever, so the deploy sat at "deploying" and never
// promoted. Nothing in the logs said the probe itself was what failed.
//
// The agent already runs on the node, already knows the host port the control
// plane allocated, and already speaks HTTP. So it does the GET itself. Nothing
// is required of the image, and the verdict no longer depends on what a
// Dockerfile author happened to install.
package health

import (
	"context"
	"net/http"
	"sync"
	"time"
)

// Reported states. These are Docker's words, kept deliberately: the control
// plane, the dashboard and the heartbeat schema already speak them, and a
// second vocabulary for the same idea would be a migration for no gain.
const (
	StatusHealthy   = "healthy"
	StatusUnhealthy = "unhealthy"
	StatusStarting  = "starting"
)

const (
	// Consecutive failures before a service that was healthy is called
	// unhealthy. Matches the Retries the Docker healthcheck used, so switching
	// to agent-side probing does not also change how twitchy the verdict is.
	Retries = 3

	// How long a service that has never yet answered is called "starting"
	// rather than "unhealthy".
	//
	// Generous on purpose. A first boot may run database migrations before it
	// listens, and Docker's own default start period is zero — which is half
	// the reason the old check looked broken even when it could run. Being
	// slow to say "unhealthy" costs nothing: promotion waits for "healthy"
	// either way, so this only affects how quickly a genuine failure is named.
	DefaultGrace = 90 * time.Second

	DefaultInterval = 10 * time.Second
	DefaultTimeout  = 5 * time.Second
)

// Target is one service to probe, as the reconciler understands it.
type Target struct {
	DeploymentID string
	URL          string
	Interval     time.Duration
	Timeout      time.Duration
	Grace        time.Duration
}

type state struct {
	target      Target
	firstSeen   time.Time
	lastProbe   time.Time
	failures    int
	everHealthy bool
	status      string
}

// Prober keeps one verdict per deployment and refreshes it on demand.
//
// Deliberately not a goroutine of its own. Probes run when the heartbeat is
// being assembled, which is the only moment the answer is read, so there is no
// background loop to leak, stop, or race with a reconcile that has just
// replaced the container underneath it.
type Prober struct {
	mu     sync.Mutex
	states map[string]*state
	client *http.Client
	now    func() time.Time
}

func New() *Prober {
	return &Prober{
		states: map[string]*state{},
		// Redirects are answered, not followed. 2xx-3xx counts as serving,
		// the same range Kubernetes treats as success; but chasing the hop
		// would let a broken service's redirect be graded on somebody else's
		// 200, which is a verdict about the wrong process.
		client: &http.Client{
			CheckRedirect: func(*http.Request, []*http.Request) error {
				return http.ErrUseLastResponse
			},
		},
		now: time.Now,
	}
}

// Track replaces the set of probed deployments.
//
// State for a deployment that is still present is kept, so a rollout that
// re-declares the same target does not reset its grace period and go back to
// "starting". State for one that has gone is dropped, which is what stops this
// map growing for the life of the agent.
func (p *Prober) Track(targets []Target) {
	p.mu.Lock()
	defer p.mu.Unlock()

	next := make(map[string]*state, len(targets))
	for _, t := range targets {
		if t.DeploymentID == "" || t.URL == "" {
			continue
		}
		if existing, ok := p.states[t.DeploymentID]; ok && existing.target.URL == t.URL {
			existing.target = t
			next[t.DeploymentID] = existing
			continue
		}
		next[t.DeploymentID] = &state{
			target:    t,
			firstSeen: p.now(),
			status:    StatusStarting,
		}
	}
	p.states = next
}

// Probe refreshes every target whose interval has elapsed.
//
// Targets are probed in parallel: this runs on the heartbeat path, and a node
// with several slow services must not add their timeouts together and delay
// the heartbeat past the point the control plane calls the node down.
func (p *Prober) Probe(ctx context.Context) {
	// The target is copied out under the lock, not read from the state inside
	// the goroutine: Track may replace it while a probe is in flight, and
	// reading it there is a data race the race detector catches only when the
	// two happen to interleave.
	type due struct {
		state  *state
		target Target
	}

	p.mu.Lock()
	now := p.now()
	pending := make([]due, 0, len(p.states))
	for _, s := range p.states {
		interval := s.target.Interval
		if interval <= 0 {
			interval = DefaultInterval
		}
		if s.lastProbe.IsZero() || now.Sub(s.lastProbe) >= interval {
			pending = append(pending, due{state: s, target: s.target})
		}
	}
	p.mu.Unlock()

	var wg sync.WaitGroup
	for _, d := range pending {
		wg.Add(1)
		go func(d due) {
			defer wg.Done()
			p.record(d.state, p.get(ctx, d.target))
		}(d)
	}
	wg.Wait()
}

// get is one request. Any 2xx or 3xx is serving; everything else, including a
// connection refused or a timeout, is not.
func (p *Prober) get(ctx context.Context, t Target) bool {
	timeout := t.Timeout
	if timeout <= 0 {
		timeout = DefaultTimeout
	}
	reqCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	req, err := http.NewRequestWithContext(reqCtx, http.MethodGet, t.URL, nil)
	if err != nil {
		return false
	}
	resp, err := p.client.Do(req)
	if err != nil {
		return false
	}
	// Drained and closed so the connection can be reused rather than leaking a
	// socket per probe on a node that probes every ten seconds for months.
	defer resp.Body.Close()
	return resp.StatusCode >= 200 && resp.StatusCode < 400
}

func (p *Prober) record(s *state, ok bool) {
	p.mu.Lock()
	defer p.mu.Unlock()

	s.lastProbe = p.now()
	if ok {
		s.failures = 0
		s.everHealthy = true
		s.status = StatusHealthy
		return
	}

	s.failures++
	grace := s.target.Grace
	if grace <= 0 {
		grace = DefaultGrace
	}
	// A service that has never answered is starting, not broken — until it has
	// had long enough that "starting" stops being credible.
	if !s.everHealthy && p.now().Sub(s.firstSeen) < grace {
		s.status = StatusStarting
		return
	}
	if s.failures >= Retries {
		s.status = StatusUnhealthy
	}
}

// Status is the last verdict for a deployment, or "" when it is not probed —
// which the caller must treat as "no opinion", never as unhealthy.
func (p *Prober) Status(deploymentID string) string {
	p.mu.Lock()
	defer p.mu.Unlock()
	if s, ok := p.states[deploymentID]; ok {
		return s.status
	}
	return ""
}

package health

import (
	"context"
	"io"
	"net/http"
	"sync"
	"time"
)

// Finding out which path a service answers on, instead of asking a person.
//
// `fleet init` writes this comment into every manifest it generates:
//
//	# No health check: container state decides whether this is up.
//	# Add one once you know a path that returns 2xx —
//
// That is the generator admitting it does not know, and handing the reader a
// research task. Nothing in a repository answers it: which path returns 2xx is
// a property of the program running, not of its source. A review that reads the
// repository perfectly still cannot say, and one that guesses is worse than
// silent -- a manifest that guessed "/" on a backend serving under a route
// prefix probed 404 for ever, reported the container unhealthy, and left every
// deploy unconfirmed until the ten-minute rollout fallback promoted it anyway.
//
// The agent is already on the node, already knows the host port, and already
// speaks HTTP. So it asks the container.

// Candidate is one path that was tried, and what came back.
//
// The status is kept even when it is a 404, because "nothing answers 2xx" is a
// finding worth recording rather than an absence: it is the difference between
// "we have not looked" and "we looked, and this service has no health path".
type Candidate struct {
	Path string `json:"path"`
	// 0 when the request itself failed -- refused, timed out, no listener.
	Status int `json:"status"`
	Bytes  int `json:"bytes"`
}

// The paths worth trying, in the order worth trying them.
//
// Preference, not just coverage. A single-page app answers 200 on "/" and so
// does a dedicated health endpoint, and the dedicated one is the better check:
// it does not render the whole application every ten seconds for the life of
// the deployment. "/" is last for that reason, not because it is unlikely.
var CandidatePaths = []string{
	"/health",
	"/healthz",
	"/api/health",
	"/_health",
	"/status",
	"/",
}

// How long a service gets to start answering before the sweep concludes that
// nothing does.
//
// The first probe of a service almost always fails, and it fails for the
// uninteresting reason: the container is running and the program inside it is
// applying migrations, or building a route table, and has not called listen
// yet. Concluding "no health path" from that would be exactly the confident
// wrong answer this exists to avoid, so a target is retried until something
// answers or this elapses.
const DiscoveryWindow = 2 * time.Minute

// DiscoverTarget is one deployment to sweep, and where to reach it.
type DiscoverTarget struct {
	DeploymentID string
	// Scheme, host and port, with no trailing slash: "http://127.0.0.1:31069".
	BaseURL string
}

type discovery struct {
	firstTry time.Time
	base     string
	// nil until the sweep has settled, one way or the other.
	result []Candidate
}

// Discoverer sweeps each deployment's candidate paths once.
//
// Once, deliberately. This is discovery and not monitoring -- the Prober does
// monitoring, continuously, for services that have a check configured. A
// service without one is swept until there is an answer to report and then
// left alone, because re-asking a settled question every ten seconds is a
// request per path per service per tick for the life of the node.
type Discoverer struct {
	mu     sync.Mutex
	states map[string]*discovery
	client *http.Client
	now    func() time.Time
}

func NewDiscoverer() *Discoverer {
	return &Discoverer{
		states: map[string]*discovery{},
		client: &http.Client{
			// Answered, not followed. A 302 to a login page means the service
			// is serving, which is the whole question here; chasing it would
			// report on wherever it led instead.
			CheckRedirect: func(*http.Request, []*http.Request) error {
				return http.ErrUseLastResponse
			},
		},
		now: time.Now,
	}
}

// Sweep probes every target that has not settled yet.
//
// Targets that have gone are forgotten, so this map does not grow for the life
// of the agent -- the same reason Track prunes.
func (d *Discoverer) Sweep(ctx context.Context, targets []DiscoverTarget) {
	d.mu.Lock()
	next := make(map[string]*discovery, len(targets))
	pending := make([]*discovery, 0, len(targets))
	for _, t := range targets {
		if t.DeploymentID == "" || t.BaseURL == "" {
			continue
		}
		s, ok := d.states[t.DeploymentID]
		if !ok || s.base != t.BaseURL {
			s = &discovery{firstTry: d.now(), base: t.BaseURL}
		}
		next[t.DeploymentID] = s
		if s.result == nil {
			pending = append(pending, s)
		}
	}
	d.states = next
	// The base URL is copied out under the lock rather than read inside the
	// goroutine, for the same reason the Prober copies its target: Sweep may
	// replace the state while a probe is in flight.
	type due struct {
		state *discovery
		base  string
		late  bool
	}
	work := make([]due, 0, len(pending))
	now := d.now()
	for _, s := range pending {
		work = append(work, due{state: s, base: s.base, late: now.Sub(s.firstTry) >= DiscoveryWindow})
	}
	d.mu.Unlock()

	var wg sync.WaitGroup
	for _, w := range work {
		wg.Add(1)
		go func(w due) {
			defer wg.Done()
			found := d.try(ctx, w.base)

			serving := false
			for _, c := range found {
				if c.Status >= 200 && c.Status < 400 {
					serving = true
					break
				}
			}
			// Settle on a positive answer immediately, and on a negative one
			// only once the window has run: a sweep that found nothing at
			// second three has learned nothing except that the program is
			// still starting.
			if !serving && !w.late {
				return
			}

			d.mu.Lock()
			w.state.result = found
			d.mu.Unlock()
		}(w)
	}
	wg.Wait()
}

func (d *Discoverer) try(ctx context.Context, base string) []Candidate {
	out := make([]Candidate, 0, len(CandidatePaths))
	for _, path := range CandidatePaths {
		reqCtx, cancel := context.WithTimeout(ctx, DefaultTimeout)
		req, err := http.NewRequestWithContext(reqCtx, http.MethodGet, base+path, nil)
		if err != nil {
			cancel()
			out = append(out, Candidate{Path: path})
			continue
		}
		resp, err := d.client.Do(req)
		if err != nil {
			cancel()
			out = append(out, Candidate{Path: path})
			continue
		}
		// Read a bounded amount rather than the whole body: this only needs a
		// size to report, and a health sweep must not pull a 40MB response
		// into a node's memory to find out it was a 200.
		n, _ := io.Copy(io.Discard, io.LimitReader(resp.Body, 1<<20))
		resp.Body.Close()
		cancel()
		out = append(out, Candidate{Path: path, Status: resp.StatusCode, Bytes: int(n)})
	}
	return out
}

// Results returns the settled sweeps, keyed by deployment.
func (d *Discoverer) Results() map[string][]Candidate {
	d.mu.Lock()
	defer d.mu.Unlock()

	out := make(map[string][]Candidate, len(d.states))
	for id, s := range d.states {
		if s.result != nil {
			out[id] = s.result
		}
	}
	return out
}

// Best is the path a manifest should use, or "" when none of them answered.
func Best(found []Candidate) string {
	for _, c := range found {
		if c.Status >= 200 && c.Status < 400 {
			return c.Path
		}
	}
	return ""
}

package health

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// probeAll forces a probe regardless of interval, which is what a test wants:
// the interval exists to spare a live node work, not to make tests sleep.
func probeAll(t *testing.T, p *Prober) {
	t.Helper()
	p.mu.Lock()
	for _, s := range p.states {
		s.lastProbe = time.Time{}
	}
	p.mu.Unlock()
	p.Probe(context.Background())
}

func TestServingServiceIsHealthy(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	p := New()
	p.Track([]Target{{DeploymentID: "d1", URL: srv.URL + "/healthz"}})
	probeAll(t, p)

	if got := p.Status("d1"); got != StatusHealthy {
		t.Fatalf("a service answering 200 should be healthy, got %q", got)
	}
}

// The MedLifeCycle failure, in miniature. The image had neither wget nor curl,
// so Docker's in-container probe could not run at all and reported unhealthy
// for ever while the service served traffic perfectly. Probing from the node
// needs nothing from the image, so the same service comes back healthy.
func TestHealthDoesNotDependOnWhatIsInsideTheImage(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// NestJS with setGlobalPrefix('api'): / is a 404 and /api is the root.
		if r.URL.Path == "/api" {
			w.WriteHeader(http.StatusOK)
			return
		}
		w.WriteHeader(http.StatusNotFound)
	}))
	defer srv.Close()

	p := New()
	p.Track([]Target{{DeploymentID: "d1", URL: srv.URL + "/api"}})
	probeAll(t, p)

	if got := p.Status("d1"); got != StatusHealthy {
		t.Fatalf("probing from the node should not need a client inside the container, got %q", got)
	}
}

func TestWrongPathIsNotHealthy(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNotFound)
	}))
	defer srv.Close()

	p := New()
	// Past the grace period already, so a failure is allowed to be named.
	p.Track([]Target{{DeploymentID: "d1", URL: srv.URL + "/", Grace: time.Nanosecond}})
	for i := 0; i < Retries; i++ {
		probeAll(t, p)
	}

	if got := p.Status("d1"); got != StatusUnhealthy {
		t.Fatalf("a 404 is not serving; want unhealthy, got %q", got)
	}
}

func TestSlowStartIsStartingNotUnhealthy(t *testing.T) {
	// Nothing is listening: a service still running its migrations.
	p := New()
	p.Track([]Target{{DeploymentID: "d1", URL: "http://127.0.0.1:1/", Timeout: 50 * time.Millisecond}})

	for i := 0; i < Retries+2; i++ {
		probeAll(t, p)
	}

	if got := p.Status("d1"); got != StatusStarting {
		t.Fatalf("a service inside its grace period is starting, not broken; got %q", got)
	}
}

func TestUnhealthyOnlyAfterGraceExpires(t *testing.T) {
	p := New()
	now := time.Unix(0, 0)
	p.now = func() time.Time { return now }

	p.Track([]Target{{DeploymentID: "d1", URL: "http://127.0.0.1:1/", Timeout: 50 * time.Millisecond, Grace: time.Minute}})

	now = now.Add(30 * time.Second)
	for i := 0; i < Retries; i++ {
		probeAll(t, p)
	}
	if got := p.Status("d1"); got != StatusStarting {
		t.Fatalf("still inside the grace period, want starting, got %q", got)
	}

	now = now.Add(2 * time.Minute)
	probeAll(t, p)
	if got := p.Status("d1"); got != StatusUnhealthy {
		t.Fatalf("past the grace period a dead service is unhealthy, got %q", got)
	}
}

// One bad probe must not unseat a service that is working. This is the
// difference between a blip and an outage, and calling a blip an outage would
// supersede a healthy release during a rollout.
func TestSingleFailureDoesNotUnseatAHealthyService(t *testing.T) {
	serving := true
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		if serving {
			w.WriteHeader(http.StatusOK)
			return
		}
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer srv.Close()

	p := New()
	p.Track([]Target{{DeploymentID: "d1", URL: srv.URL + "/"}})
	probeAll(t, p)
	if p.Status("d1") != StatusHealthy {
		t.Fatal("precondition: should start healthy")
	}

	serving = false
	probeAll(t, p)
	if got := p.Status("d1"); got != StatusHealthy {
		t.Fatalf("one failure is a blip, not an outage; got %q", got)
	}

	for i := 1; i < Retries; i++ {
		probeAll(t, p)
	}
	if got := p.Status("d1"); got != StatusUnhealthy {
		t.Fatalf("after %d consecutive failures it is unhealthy, got %q", Retries, got)
	}
}

func TestUntrackedDeploymentHasNoOpinion(t *testing.T) {
	p := New()
	if got := p.Status("nobody"); got != "" {
		t.Fatalf("an unprobed deployment must report no opinion, not a verdict; got %q", got)
	}
}

// A rollout re-declaring the same target must not reset the grace period, or a
// service that has been healthy for hours goes back to "starting" on every
// reconcile pass and can never be superseded.
func TestReTrackingKeepsExistingVerdict(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	p := New()
	target := Target{DeploymentID: "d1", URL: srv.URL + "/"}
	p.Track([]Target{target})
	probeAll(t, p)

	p.Track([]Target{target})
	if got := p.Status("d1"); got != StatusHealthy {
		t.Fatalf("re-declaring an unchanged target should keep its verdict, got %q", got)
	}
}

func TestTrackForgetsDeploymentsThatAreGone(t *testing.T) {
	p := New()
	p.Track([]Target{{DeploymentID: "d1", URL: "http://127.0.0.1:1/"}})
	p.Track([]Target{{DeploymentID: "d2", URL: "http://127.0.0.1:1/"}})

	if got := p.Status("d1"); got != "" {
		t.Fatalf("a deployment no longer in desired state should be forgotten, got %q", got)
	}
	if got := p.Status("d2"); got == "" {
		t.Fatal("the deployment still in desired state should be tracked")
	}
}

func TestRedirectCountsAsServingWithoutBeingFollowed(t *testing.T) {
	var followed bool
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/elsewhere" {
			followed = true
			w.WriteHeader(http.StatusOK)
			return
		}
		http.Redirect(w, r, "/elsewhere", http.StatusFound)
	}))
	defer srv.Close()

	p := New()
	p.Track([]Target{{DeploymentID: "d1", URL: srv.URL + "/"}})
	probeAll(t, p)

	if got := p.Status("d1"); got != StatusHealthy {
		t.Fatalf("a 302 means something is answering; want healthy, got %q", got)
	}
	if followed {
		t.Fatal("the redirect must not be followed, or the verdict is about the wrong endpoint")
	}
}

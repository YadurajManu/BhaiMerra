package health

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestDiscoverPrefersADedicatedPathOverRoot(t *testing.T) {
	// Both answer 200. The dedicated one is the better check: it does not
	// render the whole application every ten seconds for the life of the
	// deployment.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/healthz", "/":
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte("ok"))
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer srv.Close()

	d := NewDiscoverer()
	d.Sweep(context.Background(), []DiscoverTarget{{DeploymentID: "dep-1", BaseURL: srv.URL}})

	found, ok := d.Results()["dep-1"]
	if !ok {
		t.Fatal("a service that answers should settle on the first sweep")
	}
	if got := Best(found); got != "/healthz" {
		t.Fatalf("best path = %q, want /healthz", got)
	}
}

func TestDiscoverDoesNotConcludeFromAStillStartingService(t *testing.T) {
	// The first probe of a real service almost always fails, and it fails for
	// the uninteresting reason: the program is applying migrations and has not
	// called listen yet. Settling there would record "this service has no
	// health path", which is the confident wrong answer this exists to avoid.
	var serving bool
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !serving {
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		if r.URL.Path == "/health" {
			w.WriteHeader(http.StatusOK)
			return
		}
		w.WriteHeader(http.StatusNotFound)
	}))
	defer srv.Close()

	d := NewDiscoverer()
	targets := []DiscoverTarget{{DeploymentID: "dep-1", BaseURL: srv.URL}}

	d.Sweep(context.Background(), targets)
	if _, settled := d.Results()["dep-1"]; settled {
		t.Fatal("a service that answered nothing yet must not settle inside the window")
	}

	serving = true
	d.Sweep(context.Background(), targets)

	found, ok := d.Results()["dep-1"]
	if !ok {
		t.Fatal("it should settle once the service starts answering")
	}
	if got := Best(found); got != "/health" {
		t.Fatalf("best path = %q, want /health", got)
	}
}

func TestDiscoverRecordsThatNothingAnsweredOnceTheWindowRuns(t *testing.T) {
	// "Nothing answers 2xx" is a finding, not an absence. Without it the
	// manifest cannot distinguish "we have not looked" from "we looked, and
	// this service genuinely has no health path" -- and a backend serving
	// under a route prefix is exactly the second case.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNotFound)
	}))
	defer srv.Close()

	now := time.Now()
	d := NewDiscoverer()
	d.now = func() time.Time { return now }
	targets := []DiscoverTarget{{DeploymentID: "dep-1", BaseURL: srv.URL}}

	d.Sweep(context.Background(), targets)
	if _, settled := d.Results()["dep-1"]; settled {
		t.Fatal("must not settle before the window has run")
	}

	now = now.Add(DiscoveryWindow + time.Second)
	d.Sweep(context.Background(), targets)

	found, ok := d.Results()["dep-1"]
	if !ok {
		t.Fatal("once the window has run, the negative result is the answer")
	}
	if got := Best(found); got != "" {
		t.Fatalf("best path = %q, want none", got)
	}
	if len(found) != len(CandidatePaths) {
		t.Fatalf("recorded %d candidates, want all %d — the 404s are the evidence",
			len(found), len(CandidatePaths))
	}
}

func TestDiscoverForgetsDeploymentsThatAreGone(t *testing.T) {
	// The same reason Track prunes: a map keyed by deployment that is only ever
	// added to grows for the life of the agent.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	d := NewDiscoverer()
	d.Sweep(context.Background(), []DiscoverTarget{{DeploymentID: "old", BaseURL: srv.URL}})
	if _, ok := d.Results()["old"]; !ok {
		t.Fatal("precondition: the first sweep should have settled")
	}

	d.Sweep(context.Background(), []DiscoverTarget{{DeploymentID: "new", BaseURL: srv.URL}})
	if _, ok := d.Results()["old"]; ok {
		t.Fatal("a deployment no longer in the target set should be forgotten")
	}
}

func TestDiscoverTreatsARedirectAsServing(t *testing.T) {
	// A 302 to a login page means the service is up, which is the whole
	// question. Following it would report on wherever it led instead.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/" {
			http.Redirect(w, r, "https://example.invalid/login", http.StatusFound)
			return
		}
		w.WriteHeader(http.StatusNotFound)
	}))
	defer srv.Close()

	d := NewDiscoverer()
	d.Sweep(context.Background(), []DiscoverTarget{{DeploymentID: "dep-1", BaseURL: srv.URL}})

	if got := Best(d.Results()["dep-1"]); got != "/" {
		t.Fatalf("best path = %q, want /", got)
	}
}

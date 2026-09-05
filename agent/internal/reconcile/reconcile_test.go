package reconcile

import (
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"

	"github.com/fleet-os/fleet-os/agent/internal/client"
	"github.com/fleet-os/fleet-os/agent/internal/docker"
)

/*
A fake Docker daemon.

Reconciliation is the one place in the agent where getting the bookkeeping
wrong means a container is destroyed, so these exercise the real docker client
against a real HTTP server rather than a hand-rolled interface — the JSON
shapes are part of what is being tested.
*/

type fakeDaemon struct {
	mu         sync.Mutex
	containers []docker.ContainerSummary
	created    []string // names, in order
	startedIDs []string
	removedIDs []string
	networks   int
	server     *httptest.Server
}

func newFakeDaemon(t *testing.T, containers ...docker.ContainerSummary) *fakeDaemon {
	t.Helper()
	d := &fakeDaemon{containers: containers}

	mux := http.NewServeMux()
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		d.mu.Lock()
		defer d.mu.Unlock()
		path := r.URL.Path

		switch {
		case strings.HasSuffix(path, "/version"):
			_ = json.NewEncoder(w).Encode(map[string]string{
				"ApiVersion": "1.44", "MinAPIVersion": "1.24", "Version": "27.0.0",
			})

		case strings.HasSuffix(path, "/_ping"):
			w.WriteHeader(http.StatusOK)

		case strings.HasSuffix(path, "/networks/create"):
			d.networks++
			w.WriteHeader(http.StatusCreated)
			_, _ = w.Write([]byte(`{"Id":"net1"}`))

		case strings.HasSuffix(path, "/containers/json"):
			_ = json.NewEncoder(w).Encode(d.containers)

		case strings.HasSuffix(path, "/images/create"):
			// The daemon streams progress lines; an empty stream is a success.
			w.WriteHeader(http.StatusOK)

		case strings.HasSuffix(path, "/containers/create"):
			name := r.URL.Query().Get("name")
			d.created = append(d.created, name)
			w.WriteHeader(http.StatusCreated)
			_, _ = w.Write([]byte(`{"Id":"` + name + `-id","Warnings":[]}`))

		case strings.HasSuffix(path, "/start"):
			parts := strings.Split(strings.TrimPrefix(path, "/"), "/")
			d.startedIDs = append(d.startedIDs, parts[len(parts)-2])
			w.WriteHeader(http.StatusNoContent)

		case r.Method == http.MethodDelete && strings.Contains(path, "/containers/"):
			parts := strings.Split(strings.TrimPrefix(path, "/"), "/")
			d.removedIDs = append(d.removedIDs, parts[len(parts)-1])
			w.WriteHeader(http.StatusNoContent)

		default:
			w.WriteHeader(http.StatusOK)
			_, _ = io.WriteString(w, "{}")
		}
	})

	d.server = httptest.NewServer(mux)
	t.Cleanup(d.server.Close)
	return d
}

// engine wires a real docker client at the fake daemon.
func (d *fakeDaemon) engine(t *testing.T) *Engine {
	t.Helper()
	t.Setenv("DOCKER_HOST", "tcp://"+strings.TrimPrefix(d.server.URL, "http://"))
	return &Engine{
		Docker: docker.New(""),
		NodeID: "node-1",
		Log:    slog.New(slog.NewTextHandler(io.Discard, nil)),
	}
}

// managed builds a container summary the way the daemon reports one.
func managed(service, deployment string, onNetwork bool) docker.ContainerSummary {
	c := docker.ContainerSummary{
		ID:     service + "-" + deployment,
		Names:  []string{"/fleet-" + service + "-" + deployment},
		State:  "running",
		Status: "Up 2 minutes (healthy)",
		Labels: map[string]string{
			docker.LabelManaged:    "true",
			docker.LabelService:    service,
			docker.LabelDeployment: deployment,
		},
	}
	nets := map[string]struct{}{"bridge": {}}
	if onNetwork {
		nets = map[string]struct{}{docker.NetworkName: {}}
	}
	c.NetworkSettings = &struct {
		Networks map[string]struct{} `json:"Networks"`
	}{Networks: nets}
	return c
}

func desire(services ...client.DesiredService) *client.DesiredState {
	return &client.DesiredState{NodeID: "node-1", Services: services}
}

func svc(name, deployment string) client.DesiredService {
	return client.DesiredService{
		Name: name, DeploymentID: deployment, Image: "nginx:1.27", ContainerPort: 8080,
	}
}

func verbFor(actions []Action, service string) string {
	for _, a := range actions {
		if a.Service == service {
			return a.Verb
		}
	}
	return "<none>"
}

func TestASettledContainerIsLeftAlone(t *testing.T) {
	d := newFakeDaemon(t, managed("web", "dep1", true))
	actions, err := d.engine(t).Reconcile(t.Context(), desire(svc("web", "dep1")))
	if err != nil {
		t.Fatal(err)
	}
	if got := verbFor(actions, "web"); got != "unchanged" {
		t.Errorf("verb = %q, want unchanged", got)
	}
	if len(d.created) != 0 || len(d.removedIDs) != 0 {
		t.Errorf("a settled container was disturbed: created=%v removed=%v", d.created, d.removedIDs)
	}
}

func TestARolloutDoesNotRemoveTheReleaseStillServing(t *testing.T) {
	// The heart of it. During a rollout the control plane lists both the
	// release that is serving and the one being checked, and the old container
	// must survive until the new one is promoted. Removing it here is exactly
	// the outage this change exists to end.
	d := newFakeDaemon(t, managed("web", "dep1", true))
	actions, err := d.engine(t).Reconcile(t.Context(), desire(
		svc("web", "dep1"), // still running
		svc("web", "dep2"), // being rolled out
	))
	if err != nil {
		t.Fatal(err)
	}

	if len(d.removedIDs) != 0 {
		t.Errorf("the serving release was removed mid-rollout: %v", d.removedIDs)
	}
	if len(d.created) != 1 || !strings.Contains(d.created[0], "dep2") {
		t.Errorf("expected exactly the new deployment to be created, got %v", d.created)
	}
	// Two containers of one service, which is only representable because
	// reconciliation keys on the deployment rather than the service name.
	if got := verbFor(actions, "web"); got != "unchanged" && got != "started" {
		t.Errorf("unexpected verb %q", got)
	}
}

func TestPromotionRemovesThePreviousRelease(t *testing.T) {
	// Once the control plane promotes the new deployment it supersedes the old
	// one, which drops out of desired state. That is the cutover.
	d := newFakeDaemon(t,
		managed("web", "dep1", true),
		managed("web", "dep2", true),
	)
	// Twice: nothing is removed on the first pass after start, so that a
	// desired state computed before the control plane noticed this agent come
	// back cannot delete a container that should still be running.
	e := d.engine(t)
	if _, err := e.Reconcile(t.Context(), desire(svc("web", "dep2"))); err != nil {
		t.Fatal(err)
	}
	if len(d.removedIDs) != 0 {
		t.Fatalf("the first pass must remove nothing, got %v", d.removedIDs)
	}
	_, err := e.Reconcile(t.Context(), desire(svc("web", "dep2")))
	if err != nil {
		t.Fatal(err)
	}

	if len(d.removedIDs) != 1 || d.removedIDs[0] != "web-dep1" {
		t.Errorf("expected only the superseded release to be removed, got %v", d.removedIDs)
	}
	if len(d.created) != 0 {
		t.Errorf("nothing should have been created: %v", d.created)
	}
}

func TestAContainerOffTheFleetNetworkIsReplaced(t *testing.T) {
	// It is running the right image under the right deployment and can resolve
	// none of its neighbours. Nothing else would notice.
	d := newFakeDaemon(t, managed("web", "dep1", false))
	actions, err := d.engine(t).Reconcile(t.Context(), desire(svc("web", "dep1")))
	if err != nil {
		t.Fatal(err)
	}
	if got := verbFor(actions, "web"); got != "replaced" {
		t.Errorf("verb = %q, want replaced", got)
	}
	if len(d.removedIDs) != 1 || len(d.created) != 1 {
		t.Errorf("expected one removal and one creation, got removed=%v created=%v", d.removedIDs, d.created)
	}
}

func TestAServiceNoLongerScheduledHereIsRemoved(t *testing.T) {
	d := newFakeDaemon(t, managed("web", "dep1", true), managed("api", "dep9", true))
	e := d.engine(t)
	// The first pass holds; the second acts. See the hold test below.
	if _, err := e.Reconcile(t.Context(), desire(svc("web", "dep1"))); err != nil {
		t.Fatal(err)
	}
	actions, err := e.Reconcile(t.Context(), desire(svc("web", "dep1")))
	if err != nil {
		t.Fatal(err)
	}
	if got := verbFor(actions, "api"); got != "stopped" {
		t.Errorf("verb for the unscheduled service = %q, want stopped", got)
	}
	if len(d.removedIDs) != 1 || d.removedIDs[0] != "api-dep9" {
		t.Errorf("expected only api to be removed, got %v", d.removedIDs)
	}
}

func TestTheNewContainerGetsItsOwnName(t *testing.T) {
	d := newFakeDaemon(t, managed("web", "dep1", true))
	_, err := d.engine(t).Reconcile(t.Context(), desire(svc("web", "dep1"), svc("web", "dep2")))
	if err != nil {
		t.Fatal(err)
	}
	if len(d.created) != 1 {
		t.Fatalf("expected one creation, got %v", d.created)
	}
	// Colliding with the serving container's name would make the create fail
	// and the rollout stall.
	if d.created[0] == "fleet-web-dep1" {
		t.Errorf("the replacement reused the serving container's name: %q", d.created[0])
	}
	if !strings.HasPrefix(d.created[0], "fleet-web-") {
		t.Errorf("unexpected container name %q", d.created[0])
	}
}

func TestTheFleetNetworkIsEnsuredBeforeAnythingStarts(t *testing.T) {
	d := newFakeDaemon(t)
	if _, err := d.engine(t).Reconcile(t.Context(), desire(svc("web", "dep1"))); err != nil {
		t.Fatal(err)
	}
	if d.networks == 0 {
		t.Error("reconciliation started a container without ensuring the network first")
	}
}

func TestAServiceWithNoImageFailsWithoutTouchingAnything(t *testing.T) {
	d := newFakeDaemon(t)
	s := svc("web", "dep1")
	s.Image = ""
	actions, err := d.engine(t).Reconcile(t.Context(), desire(s))
	if err != nil {
		t.Fatal(err)
	}
	if got := verbFor(actions, "web"); got != "failed" {
		t.Errorf("verb = %q, want failed", got)
	}
	if len(d.created) != 0 {
		t.Errorf("nothing should have been created: %v", d.created)
	}
}

func TestListReportsTheDeploymentSoPromotionCanTellReleasesApart(t *testing.T) {
	d := newFakeDaemon(t, managed("web", "dep1", true), managed("web", "dep2", true))
	containers, err := d.engine(t).List(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	if len(containers) != 2 {
		t.Fatalf("expected both releases to be reported, got %d", len(containers))
	}
	seen := map[string]string{}
	for _, c := range containers {
		if c.DeploymentID == "" {
			t.Error("a container was reported with no deployment id; promotion cannot match it")
		}
		seen[c.DeploymentID] = c.Health
	}
	// Health is parsed out of "Up 2 minutes (healthy)" — it is what the control
	// plane gates promotion on.
	if seen["dep2"] != "healthy" {
		t.Errorf("health = %q, want healthy", seen["dep2"])
	}
}

func TestMain(m *testing.M) {
	// Keep a developer's real DOCKER_HOST out of these.
	_ = os.Unsetenv("DOCKER_HOST")
	os.Exit(m.Run())
}

func TestTheFirstPassAfterStartRemovesNothing(t *testing.T) {
	// The outage this prevents: an agent restart of about a minute ended with
	// a running database container deleted. The control plane had failed its
	// deployment while the node was silent, so the desired state the returning
	// agent was handed no longer mentioned it, and the agent reaped it.
	//
	// Removal is the one path here where being wrong destroys state instead of
	// failing, and a restart is exactly when the control plane's view of this
	// node is most likely to predate it. One pass of delay costs about ten
	// seconds; being wrong costs a database.
	d := newFakeDaemon(t, managed("web", "dep1", true), managed("db", "dep9", true))
	e := d.engine(t)

	actions, err := e.Reconcile(t.Context(), desire(svc("web", "dep1")))
	if err != nil {
		t.Fatal(err)
	}
	if len(d.removedIDs) != 0 {
		t.Errorf("the first pass must remove nothing, got %v", d.removedIDs)
	}
	if got := verbFor(actions, "db"); got != "held" {
		t.Errorf("verb = %q, want held so the hold is visible rather than silent", got)
	}

	// And it is not a permanent amnesty: the very next pass acts.
	if _, err := e.Reconcile(t.Context(), desire(svc("web", "dep1"))); err != nil {
		t.Fatal(err)
	}
	if len(d.removedIDs) != 1 || d.removedIDs[0] != "db-dep9" {
		t.Errorf("the second pass should remove it, got %v", d.removedIDs)
	}
}

func TestStartingIsNotDeferredOnTheFirstPass(t *testing.T) {
	// Only removal waits. A node that comes back with nothing running must
	// start its workloads immediately, or the hold would turn a restart into
	// an outage of its own.
	d := newFakeDaemon(t)
	actions, err := d.engine(t).Reconcile(t.Context(), desire(svc("web", "dep1")))
	if err != nil {
		t.Fatal(err)
	}
	if got := verbFor(actions, "web"); got != "started" {
		t.Errorf("verb = %q, want started on the very first pass", got)
	}
	if len(d.created) != 1 {
		t.Errorf("expected the container to be created immediately, got %v", d.created)
	}
}

func TestProbeAndDiscoverPartitionTheServices(t *testing.T) {
	// Every service belongs to exactly one of them. One in neither is a service
	// nothing ever asks about -- which is how a backend with no health check
	// went unexamined while `fleet init` told its author to go and find a path
	// that returns 2xx. One in both would be probed continuously *and* swept as
	// though it were not.
	desired := &client.DesiredState{Services: []client.DesiredService{
		{Name: "probed", DeploymentID: "d1", HostPort: 3001, HealthCheckPath: "/healthz"},
		{Name: "no-path", DeploymentID: "d2", HostPort: 3002},
		{Name: "off", DeploymentID: "d3", HostPort: 3003, HealthCheckPath: "/", HealthDisabled: true},
		// No published port: neither can reach it, and that is not a partition
		// failure -- there is nothing to ask.
		{Name: "internal", DeploymentID: "d4"},
	}}

	probed := map[string]bool{}
	for _, t := range probeTargets(desired) {
		probed[t.DeploymentID] = true
	}
	swept := map[string]bool{}
	for _, t := range discoverTargets(desired) {
		swept[t.DeploymentID] = true
	}

	for _, id := range []string{"d1", "d2", "d3"} {
		if probed[id] == swept[id] {
			t.Errorf("deployment %s is in %s — probe and discover must partition",
				id, map[bool]string{true: "both sets", false: "neither set"}[probed[id]])
		}
	}
	if probed["d4"] || swept["d4"] {
		t.Error("a service with no published port cannot be reached by either")
	}
}

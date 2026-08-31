package docker

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// newTestClient builds a client whose "launch Docker" step is counted rather
// than performed. Running the real one in a unit test would open Docker Desktop
// on whichever machine happens to be running the suite.
func newTestClient(t *testing.T, stateDir string) (*Client, *int) {
	t.Helper()
	c := New(stateDir)
	starts := 0
	c.start = func() { starts++ }
	return c, &starts
}

// markHealthy records what a successful Ping records, without needing a daemon.
func markHealthy(c *Client) {
	c.startMu.Lock()
	c.loadLocked()
	c.mem.EverHealthy = true
	c.mem.Attempts = 0
	c.mem.LastAttempt = time.Time{}
	snapshot := c.mem
	c.startMu.Unlock()
	c.persist(snapshot)
}

func TestColdPolicyStartsADaemonThatHasNeverBeenSeen(t *testing.T) {
	t.Setenv("FLEET_DOCKER_AUTOSTART", "")
	c, starts := newTestClient(t, t.TempDir())

	if !c.EnsureRunning(context.Background()) {
		t.Fatal("a genuine cold start should be helped")
	}
	if *starts != 1 {
		t.Errorf("start attempts = %d, want 1", *starts)
	}
}

func TestColdPolicyDoesNotFightAnOperatorWhoQuitDocker(t *testing.T) {
	t.Setenv("FLEET_DOCKER_AUTOSTART", "")
	c, starts := newTestClient(t, t.TempDir())

	markHealthy(c) // the daemon was up
	// ...and now the operator has quit it.

	if c.EnsureRunning(context.Background()) {
		t.Error("a daemon that was up and is now down is a person, not a fault")
	}
	if *starts != 0 {
		t.Errorf("start attempts = %d, want 0", *starts)
	}
}

// The regression this whole change exists for.
//
// Both supervisors the installer ships restart the agent on their own, so the
// decision has to survive a new process. It used to live in a struct field,
// which meant every restart relaunched the Docker the operator had just quit —
// and a credential-rejection crash loop restarted every few seconds.
func TestQuittingDockerSurvivesAnAgentRestart(t *testing.T) {
	t.Setenv("FLEET_DOCKER_AUTOSTART", "")
	dir := t.TempDir()

	first, _ := newTestClient(t, dir)
	markHealthy(first)

	// A brand new Client over the same state directory is what the next
	// process sees.
	second, starts := newTestClient(t, dir)
	if second.EnsureRunning(context.Background()) {
		t.Error("a restarted agent relaunched Docker after the operator quit it")
	}
	if *starts != 0 {
		t.Errorf("start attempts after restart = %d, want 0", *starts)
	}
}

func TestAttemptBudgetSurvivesARestartLoop(t *testing.T) {
	t.Setenv("FLEET_DOCKER_AUTOSTART", "always")
	dir := t.TempDir()

	// "always" ignores everHealthy, so only the budget and cooldown hold it
	// back. A crash loop must not get a fresh three attempts per process.
	total := 0
	for i := 0; i < maxAttempts+3; i++ {
		c, starts := newTestClient(t, dir)
		c.EnsureRunning(context.Background())
		total += *starts
	}

	// The first attempt lands; the cooldown then blocks the rest, and because
	// lastAttempt is on disk the next process is blocked by it too.
	if total != 1 {
		t.Errorf("start attempts across %d restarts = %d, want 1 (cooldown is persisted)", maxAttempts+3, total)
	}
}

func TestBudgetIsCappedEvenWithoutACooldown(t *testing.T) {
	t.Setenv("FLEET_DOCKER_AUTOSTART", "always")
	dir := t.TempDir()

	total := 0
	for i := 0; i < maxAttempts+3; i++ {
		c, starts := newTestClient(t, dir)
		// Age the cooldown out, leaving only the attempt cap in play.
		c.startMu.Lock()
		c.loadLocked()
		c.mem.LastAttempt = time.Now().Add(-2 * startCooldown)
		snapshot := c.mem
		c.startMu.Unlock()
		c.persist(snapshot)

		c.EnsureRunning(context.Background())
		total += *starts
	}

	if total != maxAttempts {
		t.Errorf("start attempts = %d, want the cap of %d", total, maxAttempts)
	}
}

func TestNeverPolicyNeverStarts(t *testing.T) {
	t.Setenv("FLEET_DOCKER_AUTOSTART", "never")
	c, starts := newTestClient(t, t.TempDir())

	if c.EnsureRunning(context.Background()) {
		t.Error("never must mean never, even on a cold start")
	}
	if *starts != 0 {
		t.Errorf("start attempts = %d, want 0", *starts)
	}
}

func TestAlwaysPolicyIgnoresThePersistedDecision(t *testing.T) {
	t.Setenv("FLEET_DOCKER_AUTOSTART", "always")
	dir := t.TempDir()

	first, _ := newTestClient(t, dir)
	markHealthy(first)

	second, starts := newTestClient(t, dir)
	if !second.EnsureRunning(context.Background()) {
		t.Error("always is the opt-in to the old behaviour and must still start")
	}
	if *starts != 1 {
		t.Errorf("start attempts = %d, want 1", *starts)
	}
}

func TestAHealthyPingClearsTheBudgetOnDisk(t *testing.T) {
	t.Setenv("FLEET_DOCKER_AUTOSTART", "always")
	dir := t.TempDir()

	c, _ := newTestClient(t, dir)
	c.EnsureRunning(context.Background()) // burns one attempt, sets the cooldown
	markHealthy(c)                        // the daemon came up

	// A genuine crash weeks later still gets helped, from a fresh process.
	next, starts := newTestClient(t, dir)
	if !next.EnsureRunning(context.Background()) {
		t.Error("a daemon that came back should reset the budget")
	}
	if *starts != 1 {
		t.Errorf("start attempts = %d, want 1", *starts)
	}
}

func TestAnUnwritableStateDirDegradesToInMemory(t *testing.T) {
	t.Setenv("FLEET_DOCKER_AUTOSTART", "")

	// No state directory at all: the agent must still make a decision rather
	// than refusing to talk to Docker.
	c, starts := newTestClient(t, "")
	if !c.EnsureRunning(context.Background()) {
		t.Error("a client with no state path should still handle a cold start")
	}
	if *starts != 1 {
		t.Errorf("start attempts = %d, want 1", *starts)
	}

	markHealthy(c)
	if c.EnsureRunning(context.Background()) {
		t.Error("the in-memory decision should still hold within one process")
	}
}

func TestCorruptStateReadsAsAColdStart(t *testing.T) {
	t.Setenv("FLEET_DOCKER_AUTOSTART", "")
	dir := t.TempDir()

	// A truncated write must not strand the node: falling back to a cold start
	// is the safe direction, because the alternative is a node that can never
	// bring its runtime up.
	if err := os.WriteFile(filepath.Join(dir, autostartFile), []byte("{not json"), 0o600); err != nil {
		t.Fatal(err)
	}

	c, starts := newTestClient(t, dir)
	if !c.EnsureRunning(context.Background()) {
		t.Error("unreadable state should degrade to a cold start")
	}
	if *starts != 1 {
		t.Errorf("start attempts = %d, want 1", *starts)
	}
}

func TestPersistedStateRoundTrips(t *testing.T) {
	dir := t.TempDir()
	c, _ := newTestClient(t, dir)

	markHealthy(c)

	if _, err := os.Stat(filepath.Join(dir, autostartFile)); err != nil {
		t.Fatalf("expected %s to be written: %v", autostartFile, err)
	}

	next, _ := newTestClient(t, dir)
	next.startMu.Lock()
	next.loadLocked()
	got := next.mem
	next.startMu.Unlock()

	if !got.EverHealthy {
		t.Error("everHealthy did not survive the round trip")
	}
	if got.Attempts != 0 {
		t.Errorf("attempts = %d, want 0", got.Attempts)
	}
}

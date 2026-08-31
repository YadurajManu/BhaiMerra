package docker

import (
	"net/http"
	"testing"
)

func TestOnFleetNetwork(t *testing.T) {
	attached := ContainerSummary{}
	attached.NetworkSettings = &struct {
		Networks map[string]struct{} `json:"Networks"`
	}{Networks: map[string]struct{}{NetworkName: {}}}

	if !OnFleetNetwork(attached) {
		t.Error("a container on the fleet network should be reported as attached")
	}

	// The case this exists for: a container created before the fleet network,
	// still running the right image, unable to resolve any of its neighbours.
	legacy := ContainerSummary{}
	legacy.NetworkSettings = &struct {
		Networks map[string]struct{} `json:"Networks"`
	}{Networks: map[string]struct{}{"bridge": {}}}

	if OnFleetNetwork(legacy) {
		t.Error("a container on the default bridge must not count as attached")
	}

	// An older daemon, or a filtered listing, may not report networks at all.
	// Treating that as "not attached" costs one replacement; treating it as
	// attached would leave a broken container in place indefinitely.
	if OnFleetNetwork(ContainerSummary{}) {
		t.Error("absent network information must not be read as attached")
	}
}

func TestIsAlreadyExists(t *testing.T) {
	// Two agents reconciling at once both try to create the network. The loser
	// gets a 409, which is the desired state rather than a failure.
	if !isAlreadyExists(&Error{StatusCode: http.StatusConflict, Message: "network already exists"}) {
		t.Error("409 should be read as already created")
	}
	// Some daemon versions answer 500 with the same meaning in the message.
	if !isAlreadyExists(&Error{StatusCode: 500, Message: `network with name fleet already exists`}) {
		t.Error("the message should be enough when the status is not 409")
	}
	if isAlreadyExists(&Error{StatusCode: 500, Message: "no such image"}) {
		t.Error("an unrelated failure must not be swallowed as already-exists")
	}
	if isAlreadyExists(nil) {
		t.Error("nil is not an already-exists error")
	}
}

func TestMentionsNetwork(t *testing.T) {
	if !mentionsNetwork(&Error{StatusCode: 404, Message: "network fleet not found"}) {
		t.Error("a missing network should invalidate the cached answer")
	}
	if mentionsNetwork(&Error{StatusCode: 404, Message: "no such image: nginx"}) {
		t.Error("a missing image is not a reason to recreate the network")
	}
}

func TestEnsureNetworkCachesPerClient(t *testing.T) {
	c := New("")
	c.netMu.Lock()
	c.networkReady = true
	c.netMu.Unlock()

	// A client with nowhere to connect would fail if the call went out; the
	// cached answer means it never does.
	if err := c.EnsureNetwork(t.Context()); err != nil {
		t.Errorf("a cached network should not be re-created: %v", err)
	}

	// The cache must not be shared. It was package-level to begin with, which
	// meant a second client inherited an answer about a daemon it had never
	// spoken to — and silently skipped creating the network there.
	other := New("")
	other.netMu.Lock()
	inherited := other.networkReady
	other.netMu.Unlock()
	if inherited {
		t.Error("a fresh client inherited another client's network state")
	}

	c.forgetNetwork()
	c.netMu.Lock()
	ready := c.networkReady
	c.netMu.Unlock()
	if ready {
		t.Error("forgetNetwork should clear the cache so the next pass retries")
	}
}

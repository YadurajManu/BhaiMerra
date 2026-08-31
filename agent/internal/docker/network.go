package docker

import (
	"context"
	"net/http"
	"strings"
	"sync"
)

// NetworkName is the user-defined bridge every Fleet container joins.
//
// The default bridge is not good enough, and the difference is the entire
// reason this file exists: containers on the default bridge have no name
// resolution between them, so one service can only reach another by IP and
// port. Docker runs an embedded DNS server for user-defined networks, which is
// what lets `postgres` be a hostname instead of an address that changes on
// every restart.
//
// A node belongs to exactly one fleet, so one network name is enough.
const NetworkName = "fleet"

type networkCreateRequest struct {
	Name           string `json:"Name"`
	Driver         string `json:"Driver"`
	CheckDuplicate bool   `json:"CheckDuplicate"`
	// Marks the network as ours, so a human looking at `docker network ls`
	// knows what created it and why.
	Labels map[string]string `json:"Labels,omitempty"`
}

var networkOnce struct {
	mu    sync.Mutex
	ready bool
}

// EnsureNetwork creates the fleet network if it is not already there.
//
// Idempotent in both directions: a 409 means somebody else created it first,
// which is the desired state and not an error. The result is cached so the
// common path is free, but a failure clears the cache so the next reconcile
// retries rather than assuming a network that was never made.
func (c *Client) EnsureNetwork(ctx context.Context) error {
	networkOnce.mu.Lock()
	ready := networkOnce.ready
	networkOnce.mu.Unlock()
	if ready {
		return nil
	}

	err := c.do(ctx, http.MethodPost, "/"+c.api(ctx)+"/networks/create", networkCreateRequest{
		Name:           NetworkName,
		Driver:         "bridge",
		CheckDuplicate: true,
		Labels:         map[string]string{LabelManaged: "true"},
	}, nil)

	if err != nil && !isAlreadyExists(err) {
		return err
	}

	networkOnce.mu.Lock()
	networkOnce.ready = true
	networkOnce.mu.Unlock()
	return nil
}

// forgetNetwork drops the cached "it exists" answer, so the next reconcile
// tries again. Called when attaching a container to it fails, which is the
// symptom of somebody having removed it underneath us.
func forgetNetwork() {
	networkOnce.mu.Lock()
	networkOnce.ready = false
	networkOnce.mu.Unlock()
}

// isAlreadyExists reports whether the daemon is telling us the network is
// already there. Docker answers 409 for this, but the message is the only
// thing that distinguishes it from other conflicts on some versions.
func isAlreadyExists(err error) bool {
	var de *Error
	if !asError(err, &de) {
		return false
	}
	if de.StatusCode == http.StatusConflict {
		return true
	}
	return strings.Contains(strings.ToLower(de.Message), "already exists")
}

// OnFleetNetwork reports whether a container is attached to the fleet network.
//
// Used by reconciliation to replace containers created before this existed:
// they are healthy and running the right image, so nothing else would notice
// they are on the default bridge and cannot resolve their neighbours.
func OnFleetNetwork(summary ContainerSummary) bool {
	if summary.NetworkSettings == nil {
		return false
	}
	_, ok := summary.NetworkSettings.Networks[NetworkName]
	return ok
}

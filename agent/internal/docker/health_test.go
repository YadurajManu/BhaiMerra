package docker

import (
	"strings"
	"testing"
)

func TestHealthTestCommandProbesTheContainerItself(t *testing.T) {
	h := &HealthSpec{Path: "/healthz", Port: 8080}
	cmd := h.testCommand()

	if cmd[0] != "CMD-SHELL" {
		t.Errorf("test form = %q, want CMD-SHELL so the fallback chain can run", cmd[0])
	}

	probe := cmd[1]
	// 127.0.0.1, not the service name: the check runs inside the container and
	// is asking whether *this* process is up, not whether DNS works.
	if !strings.Contains(probe, "http://127.0.0.1:8080/healthz") {
		t.Errorf("probe does not target the container's own port: %s", probe)
	}
	// Busybox images ship wget, Debian-based ones usually curl. Requiring one
	// specific tool means the check fails on half the images people deploy.
	if !strings.Contains(probe, "wget") || !strings.Contains(probe, "curl") {
		t.Errorf("probe should try both wget and curl: %s", probe)
	}
	if !strings.Contains(probe, "exit 1") {
		t.Errorf("probe must fail explicitly when neither tool works: %s", probe)
	}
}

func TestHealthTestCommandQuotesTheUrl(t *testing.T) {
	// The path comes from a manifest, which is user input reaching a shell.
	h := &HealthSpec{Path: "/health;rm -rf /", Port: 80}
	probe := h.testCommand()[1]

	// %q wraps it in double quotes and escapes what is inside, so the semicolon
	// cannot end the command.
	if !strings.Contains(probe, `"http://127.0.0.1:80/health;rm -rf /"`) {
		t.Errorf("the url should be quoted as a single argument: %s", probe)
	}
}

func TestRunSpecWithoutHealthProducesNoHealthcheck(t *testing.T) {
	// A nil Health has to stay nil in the request: an empty healthcheck object
	// would override whatever the image itself declares.
	spec := RunSpec{Service: "web", Image: "nginx"}
	if spec.Health != nil {
		t.Fatal("a spec with no health block should carry no HealthSpec")
	}
}

func TestAgentProbedServiceDisablesDockersOwnCheck(t *testing.T) {
	// "NONE" rather than no healthcheck at all. Left unset, an image that ships
	// its own HEALTHCHECK keeps running it, and the node would then have two
	// verdicts about one container that can disagree.
	hc := healthcheckFor(RunSpec{Service: "api", ProbedByAgent: true})
	if hc == nil {
		t.Fatal("a spec probed by the agent must switch Docker's check off explicitly, not leave it unset")
	}
	if len(hc.Test) != 1 || hc.Test[0] != "NONE" {
		t.Fatalf("test = %v, want [NONE]", hc.Test)
	}
}

func TestAgentProbingWinsOverAnInContainerSpec(t *testing.T) {
	// Both set is not a contradiction to resolve at the daemon: the agent's
	// probe is the one that does not depend on the image's contents.
	hc := healthcheckFor(RunSpec{
		Service:       "api",
		ProbedByAgent: true,
		Health:        &HealthSpec{Path: "/healthz", Port: 8080},
	})
	if len(hc.Test) != 1 || hc.Test[0] != "NONE" {
		t.Fatalf("test = %v, want the agent's probe to win", hc.Test)
	}
}

func TestInternalServiceStillProbesFromInside(t *testing.T) {
	// No host port to reach it on, so the in-container probe is the only route
	// left. It keeps the wget/curl dependency, which is why it is the fallback
	// and not the default.
	hc := healthcheckFor(RunSpec{Service: "worker", Health: &HealthSpec{Path: "/healthz", Port: 8080}})
	if hc == nil {
		t.Fatal("a service with no host port still needs a check")
	}
	if hc.Test[0] != "CMD-SHELL" {
		t.Fatalf("test form = %q, want CMD-SHELL", hc.Test[0])
	}
	if hc.Retries != 3 {
		t.Errorf("retries = %d, want 3", hc.Retries)
	}
}

func TestNoHealthLeavesTheImagesOwnCheckAlone(t *testing.T) {
	if hc := healthcheckFor(RunSpec{Service: "web", Image: "nginx"}); hc != nil {
		t.Fatalf("healthcheck = %v, want nil so the image's own check still applies", hc)
	}
}

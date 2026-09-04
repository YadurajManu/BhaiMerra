package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"github.com/fleet-os/fleet-os/agent/internal/client"
	"github.com/fleet-os/fleet-os/agent/internal/state"
	"github.com/fleet-os/fleet-os/agent/internal/upgrade"
)

// A control plane that serves one build, so the whole path can be exercised:
// fetch the checksums, download, verify, stage, remember.
func servePublished(t *testing.T, body []byte, corrupt bool) *httptest.Server {
	t.Helper()
	return serveWithGate(t, body, corrupt, true)
}

func serveWithGate(t *testing.T, body []byte, corrupt, autoUpgrade bool) *httptest.Server {
	t.Helper()
	name := upgrade.BinaryName(runtime.GOOS, runtime.GOARCH)
	sum := sha256.Sum256(body)

	mux := http.NewServeMux()
	mux.HandleFunc("/agent/desired-state", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("content-type", "application/json")
		fmt.Fprintf(w, `{"node_id":"n1","generated_at":"","services":[],"agent_auto_upgrade":%t}`, autoUpgrade)
	})
	mux.HandleFunc("/install/SHA256SUMS", func(w http.ResponseWriter, _ *http.Request) {
		fmt.Fprintf(w, "%s  %s\n", hex.EncodeToString(sum[:]), name)
	})
	mux.HandleFunc("/install/"+name, func(w http.ResponseWriter, _ *http.Request) {
		if corrupt {
			// What a truncated download, a proxy, or a tampered mirror looks
			// like: the checksum is honest, the bytes are not.
			w.Write([]byte("this is not the published binary"))
			return
		}
		w.Write(body)
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return srv
}

func testState(t *testing.T, dir string) (*state.State, string) {
	t.Helper()
	st := &state.State{NodeID: "n1", Name: "test", AgentToken: "flt_x", ControlPlaneURL: "x"}
	path := filepath.Join(dir, "agent.json")
	if err := state.Save(path, st); err != nil {
		t.Fatal(err)
	}
	return st, path
}

func quietLog() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

func TestCheckForUpgradeStagesAVerifiedBuild(t *testing.T) {
	dir := t.TempDir()
	published := []byte("#!/bin/sh\necho published build\n")
	srv := servePublished(t, published, false)

	st, path := testState(t, dir)
	api := client.New(srv.URL, "flt_x")

	// The running binary is the test binary, whose hash is not the published
	// one, so this is the ordinary "a newer build exists" case.
	if !checkForUpgrade(context.Background(), api, st, path, quietLog()) {
		t.Fatal("a published build that differs should be staged")
	}

	staged := filepath.Join(dir, upgrade.StagedName)
	got, err := os.ReadFile(staged)
	if err != nil {
		t.Fatalf("nothing staged: %v", err)
	}
	if string(got) != string(published) {
		t.Fatal("staged bytes differ from what was served")
	}
	info, err := os.Stat(staged)
	if err != nil || info.Mode().Perm()&0o111 == 0 {
		t.Fatalf("staged binary must be executable, got %v", info.Mode())
	}

	// Remembered, so the next tick does not download the same bytes again.
	reloaded, err := state.Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if reloaded.UpgradeStaged == "" || reloaded.UpgradeAttempts != 1 {
		t.Fatalf("state not recorded: %+v", reloaded)
	}
}

func TestCheckForUpgradeRefusesBytesThatDoNotMatch(t *testing.T) {
	dir := t.TempDir()
	srv := servePublished(t, []byte("#!/bin/sh\necho real\n"), true)

	st, path := testState(t, dir)
	api := client.New(srv.URL, "flt_x")

	if checkForUpgrade(context.Background(), api, st, path, quietLog()) {
		t.Fatal("a download that fails verification must not trigger a restart")
	}
	// The security property, stated plainly: unverified bytes are never left
	// anywhere the pre-start step would install them as root.
	if _, err := os.Stat(filepath.Join(dir, upgrade.StagedName)); !os.IsNotExist(err) {
		t.Fatal("unverified bytes must not be staged")
	}
	reloaded, _ := state.Load(path)
	if reloaded.UpgradeStaged != "" {
		t.Fatal("a rejected download must not be recorded as staged")
	}
}

func TestCheckForUpgradeStopsAfterRepeatedFailures(t *testing.T) {
	dir := t.TempDir()
	published := []byte("#!/bin/sh\necho published\n")
	srv := servePublished(t, published, false)
	sum := sha256.Sum256(published)

	st, path := testState(t, dir)
	// Pretend this build has already been staged twice and the agent is still
	// running the old one - the unit is too old to install it.
	st.UpgradeStaged = hex.EncodeToString(sum[:])
	st.UpgradeAttempts = upgrade.MaxAttempts
	if err := state.Save(path, st); err != nil {
		t.Fatal(err)
	}
	api := client.New(srv.URL, "flt_x")

	if checkForUpgrade(context.Background(), api, st, path, quietLog()) {
		t.Fatal("a build that will not install must not restart the node forever")
	}
}

func TestCheckForUpgradeSurvivesAnUnreachableControlPlane(t *testing.T) {
	dir := t.TempDir()
	st, path := testState(t, dir)
	// Nothing listening: a node that cannot reach the control plane must keep
	// running the version it has, not fall over.
	api := client.New("http://127.0.0.1:1", "flt_x")

	if checkForUpgrade(context.Background(), api, st, path, quietLog()) {
		t.Fatal("an unreachable control plane is not an upgrade")
	}
}

func TestCheckForUpgradeRespectsTheFleetOptIn(t *testing.T) {
	dir := t.TempDir()
	published := []byte("#!/bin/sh\necho published\n")
	// A build is available and verifiable; the fleet simply has not opted in.
	srv := serveWithGate(t, published, false, false)

	st, path := testState(t, dir)
	api := client.New(srv.URL, "flt_x")

	if checkForUpgrade(context.Background(), api, st, path, quietLog()) {
		t.Fatal("a fleet that has not opted in must not be upgraded")
	}
	if _, err := os.Stat(filepath.Join(dir, upgrade.StagedName)); !os.IsNotExist(err) {
		t.Fatal("nothing may be staged for a fleet that has not opted in")
	}
}

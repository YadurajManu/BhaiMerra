package upgrade

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func sumOf(b []byte) string {
	h := sha256.Sum256(b)
	return hex.EncodeToString(h[:])
}

func TestParseSums(t *testing.T) {
	body := `
d2d4b1f8a0a9a2c2f39b4a4a1f6a1b9d9c1e2f3a4b5c6d7e8f90123456789abc  fleet-agent-linux-amd64
*not-a-checksum  fleet-agent-linux-arm64
aaaabbbbccccddddeeeeffff00001111222233334444555566667777888899990 fleet-agent-too-long
1111111111111111111111111111111111111111111111111111111111111111 *fleet-agent-darwin-arm64
`
	sums := ParseSums(body)

	if got := sums["fleet-agent-linux-amd64"]; got != "d2d4b1f8a0a9a2c2f39b4a4a1f6a1b9d9c1e2f3a4b5c6d7e8f90123456789abc" {
		t.Fatalf("linux-amd64 = %q", got)
	}
	// The binary-mode "*" marker belongs to the format, not the filename.
	if _, ok := sums["fleet-agent-darwin-arm64"]; !ok {
		t.Fatal("a *-prefixed filename should still be found")
	}
	// Junk must be dropped rather than stored as a checksum nothing can match,
	// which would look like "an upgrade is available" on every single tick.
	if _, ok := sums["fleet-agent-linux-arm64"]; ok {
		t.Fatal("a malformed checksum must not be accepted")
	}
	if _, ok := sums["fleet-agent-too-long"]; ok {
		t.Fatal("a 65-character checksum must not be accepted")
	}
}

func TestPublished(t *testing.T) {
	sums := map[string]string{"fleet-agent-linux-amd64": strings.Repeat("a", 64)}

	// A caller may hold a path; the published file lists bare names. If these
	// did not meet, the answer would be a silent "never upgrade".
	got, err := Published(sums, "/usr/local/bin/fleet-agent-linux-amd64")
	if err != nil || got != strings.Repeat("a", 64) {
		t.Fatalf("by path: %q, %v", got, err)
	}
	if _, err := Published(sums, "fleet-agent-plan9-386"); err != ErrNoEntry {
		t.Fatalf("a platform with no build should be ErrNoEntry, got %v", err)
	}
}

func TestDecide(t *testing.T) {
	const running = "1111111111111111111111111111111111111111111111111111111111111111"
	const published = "2222222222222222222222222222222222222222222222222222222222222222"

	cases := []struct {
		name    string
		running string
		pub     string
		state   State
		want    Decision
	}{
		{"identical", running, running, State{}, UpToDate},
		{"nothing published", running, "", State{}, UpToDate},
		{"a new build", running, published, State{}, Upgrade},
		{
			"already waiting for a restart",
			running, published,
			State{LastStaged: published, Attempts: 1},
			AlreadyStaged,
		},
		{
			"staged twice and still not running it",
			running, published,
			State{LastStaged: published, Attempts: MaxAttempts},
			Failed,
		},
		{
			"a different build than the one that failed",
			running, published,
			State{LastStaged: "3333333333333333333333333333333333333333333333333333333333333333", Attempts: 9},
			Upgrade,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := Decide(tc.running, tc.pub, tc.state); got != tc.want {
				t.Fatalf("Decide() = %v, want %v", got, tc.want)
			}
		})
	}
}

func TestBinaryName(t *testing.T) {
	if got := BinaryName("linux", "arm64"); got != "fleet-agent-linux-arm64" {
		t.Fatalf("linux: %q", got)
	}
	// Windows binaries carry the extension the build produces; without it the
	// checksum lookup would miss and Windows would never upgrade.
	if got := BinaryName("windows", "amd64"); got != "fleet-agent-windows-amd64.exe" {
		t.Fatalf("windows: %q", got)
	}
}

func TestStageVerifiesBeforeWriting(t *testing.T) {
	dir := t.TempDir()
	payload := []byte("#!/bin/sh\necho new agent\n")

	t.Run("rejects a body that does not match", func(t *testing.T) {
		_, err := Stage(dir, bytes.NewReader(payload), strings.Repeat("f", 64))
		if err == nil {
			t.Fatal("a checksum mismatch must be an error")
		}
		if !strings.Contains(err.Error(), "checksum mismatch") {
			t.Fatalf("unclear error: %v", err)
		}
		// The critical part: nothing executable may be left behind for the
		// pre-start step to install.
		if _, err := os.Stat(filepath.Join(dir, StagedName)); !os.IsNotExist(err) {
			t.Fatal("a rejected download must not be staged")
		}
		entries, _ := os.ReadDir(dir)
		for _, e := range entries {
			if strings.HasPrefix(e.Name(), ".agent.download-") {
				t.Fatalf("a temporary file was left behind: %s", e.Name())
			}
		}
	})

	t.Run("stages a body that matches, executable", func(t *testing.T) {
		path, err := Stage(dir, bytes.NewReader(payload), sumOf(payload))
		if err != nil {
			t.Fatalf("Stage: %v", err)
		}
		if filepath.Base(path) != StagedName {
			t.Fatalf("staged at %q", path)
		}
		got, err := os.ReadFile(path)
		if err != nil || !bytes.Equal(got, payload) {
			t.Fatalf("staged contents differ: %v", err)
		}
		info, err := os.Stat(path)
		if err != nil {
			t.Fatal(err)
		}
		// The pre-start step installs it and systemd executes it; a file
		// without the bit set turns an upgrade into a node that will not start.
		if info.Mode().Perm()&0o111 == 0 {
			t.Fatalf("staged binary is not executable: %v", info.Mode())
		}
	})

	t.Run("overwrites an earlier staging", func(t *testing.T) {
		second := []byte("#!/bin/sh\necho newer\n")
		if _, err := Stage(dir, bytes.NewReader(second), sumOf(second)); err != nil {
			t.Fatalf("Stage: %v", err)
		}
		got, _ := os.ReadFile(filepath.Join(dir, StagedName))
		if !bytes.Equal(got, second) {
			t.Fatal("the newer build should replace the one waiting")
		}
	})
}

func TestHashFile(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "bin")
	payload := []byte("fleet")
	if err := os.WriteFile(path, payload, 0o755); err != nil {
		t.Fatal(err)
	}
	got, err := HashFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if got != sumOf(payload) {
		t.Fatalf("HashFile = %s", got)
	}
	if _, err := HashFile(filepath.Join(dir, "absent")); err == nil {
		t.Fatal("a missing file must be an error, not an empty hash that matches nothing")
	}
}

func TestInstallStagedReplacesTheRunningBinary(t *testing.T) {
	dir := t.TempDir()
	staged := filepath.Join(dir, StagedName)
	if err := os.WriteFile(staged, []byte("#!/bin/sh\necho new\n"), 0o755); err != nil {
		t.Fatal(err)
	}

	// A destination of our own, so the test does not overwrite the binary it
	// is currently running as.
	self := filepath.Join(dir, "fleet-agent")
	if err := os.WriteFile(self, []byte("#!/bin/sh\necho old\n"), 0o755); err != nil {
		t.Fatal(err)
	}

	installed, err := installStagedInto(staged, self)
	if err != nil {
		t.Fatalf("install: %v", err)
	}
	if !installed {
		t.Fatal("a staged binary should have been installed")
	}
	got, err := os.ReadFile(self)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(got), "echo new") {
		t.Errorf("the running binary was not replaced: %q", got)
	}
	// The staged file is removed only after the replacement is in place: while
	// it exists, the upgrade is still owed and would be retried.
	if _, err := os.Stat(staged); !os.IsNotExist(err) {
		t.Error("the staged file should be gone once it has been installed")
	}
}

func TestInstallStagedIsANoOpWithNothingStaged(t *testing.T) {
	// The overwhelmingly common case, and emphatically not an error — this
	// runs on every single agent start.
	installed, err := InstallStaged(t.TempDir())
	if err != nil {
		t.Fatalf("nothing staged must not be an error, got %v", err)
	}
	if installed {
		t.Error("nothing was staged, so nothing should have been installed")
	}
}

func TestInstallStagedRefusesANonExecutableFile(t *testing.T) {
	// Something that cannot be executed is not an upgrade, and renaming it
	// over the running agent would take the node down until someone noticed.
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, StagedName), []byte("not a binary"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := InstallStaged(dir); err == nil {
		t.Fatal("a non-executable staged file should be refused, not installed")
	}
}

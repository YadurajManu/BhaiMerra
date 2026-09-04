// Package upgrade replaces the agent's own binary with the one the control
// plane serves.
//
// Without this, an agent is whatever version it was installed at, forever. The
// only way to move it was `install.sh --reset`, which re-pairs the node and
// discards its history — so on a fleet of any size, every agent improvement
// was undeliverable to the machines that already existed.
//
// The identity here is the binary's SHA-256, not a version string. The control
// plane serves exactly one build per platform and publishes SHA256SUMS beside
// it, so "am I the build being served" is a question with an exact answer,
// where a version string is a claim that can be stale, forged, or simply
// forgotten at build time.
//
// Nothing here runs the downloaded file. It is verified, staged in the state
// directory, and installed by a privileged pre-start step in the unit — the
// agent itself runs under ProtectSystem=strict and cannot write to
// /usr/local/bin, which is deliberate and worth keeping.
package upgrade

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

// StagedName is where a verified binary waits for the pre-start step to
// install it. It lives in the state directory because that is the only path
// the sandboxed agent may write.
const StagedName = "agent.staged"

// ErrNoEntry means SHA256SUMS says nothing about this platform's binary, which
// is not a failure — a control plane may simply not ship for it.
var ErrNoEntry = errors.New("no checksum published for this platform")

// ParseSums reads the `shasum -a 256` format: "<hex>  <filename>" per line.
//
// Filenames are matched by base name only. The published file lists bare names
// while a caller may hold a path, and a mismatch there would silently mean
// "never upgrade" rather than an error anyone would notice.
func ParseSums(body string) map[string]string {
	out := map[string]string{}
	for _, line := range strings.Split(body, "\n") {
		fields := strings.Fields(line)
		if len(fields) < 2 {
			continue
		}
		sum := strings.ToLower(fields[0])
		if len(sum) != 64 || !isHex(sum) {
			continue
		}
		// The second field may carry a "*" binary-mode marker.
		name := filepath.Base(strings.TrimPrefix(fields[len(fields)-1], "*"))
		out[name] = sum
	}
	return out
}

func isHex(s string) bool {
	_, err := hex.DecodeString(s)
	return err == nil
}

// Published returns the checksum for one binary name.
func Published(sums map[string]string, binary string) (string, error) {
	sum, ok := sums[filepath.Base(binary)]
	if !ok {
		return "", ErrNoEntry
	}
	return sum, nil
}

// HashFile is the SHA-256 of a file, lowercase hex.
func HashFile(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()

	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

// Decision is what to do about the published build.
type Decision int

const (
	// UpToDate: the running binary is the one being served.
	UpToDate Decision = iota
	// Upgrade: they differ, and nothing has been staged for this checksum yet.
	Upgrade
	// AlreadyStaged: this exact build is waiting for the next restart. Doing it
	// again would download the same bytes every reconcile forever.
	AlreadyStaged
	// Failed: this checksum was staged before and the agent is still running the
	// old binary, so installing it is not working. Retrying on a loop would
	// hammer the control plane and never converge, so it stops and says so.
	Failed
)

func (d Decision) String() string {
	switch d {
	case UpToDate:
		return "up to date"
	case Upgrade:
		return "upgrade"
	case AlreadyStaged:
		return "already staged"
	case Failed:
		return "install is not taking effect"
	}
	return "unknown"
}

// State is what the agent remembers about upgrades between restarts.
type State struct {
	// The checksum most recently staged, if any.
	LastStaged string `json:"last_staged,omitempty"`
	// How many times that checksum has been staged without becoming the running
	// binary. Two is enough to know it is not a slow restart.
	Attempts int `json:"attempts,omitempty"`
}

// MaxAttempts before an upgrade is declared broken and abandoned.
//
// One failure is a restart that has not happened yet — systemd may simply not
// have cycled the unit. Two is a pattern: the staged file is not being
// installed, and continuing would re-download the same bytes forever while
// achieving nothing.
const MaxAttempts = 2

// Decide compares the running binary against what is published.
func Decide(runningSum, publishedSum string, st State) Decision {
	if publishedSum == "" || runningSum == publishedSum {
		return UpToDate
	}
	if st.LastStaged == publishedSum {
		if st.Attempts >= MaxAttempts {
			return Failed
		}
		return AlreadyStaged
	}
	return Upgrade
}

// BinaryName is the file the control plane serves for a platform, matching the
// names the build produces.
func BinaryName(goos, goarch string) string {
	if goos == "windows" {
		return fmt.Sprintf("fleet-agent-%s-%s.exe", goos, goarch)
	}
	return fmt.Sprintf("fleet-agent-%s-%s", goos, goarch)
}

// Stage writes verified bytes to the staging path.
//
// Written to a temporary file in the same directory and renamed, so a restart
// in the middle of a download can never leave a half-written binary where the
// pre-start step will find it and install it.
func Stage(stateDir string, body io.Reader, wantSum string) (string, error) {
	if err := os.MkdirAll(stateDir, 0o755); err != nil {
		return "", err
	}
	tmp, err := os.CreateTemp(stateDir, ".agent.download-*")
	if err != nil {
		return "", err
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName) // no-op once the rename below has succeeded

	h := sha256.New()
	if _, err := io.Copy(io.MultiWriter(tmp, h), body); err != nil {
		tmp.Close()
		return "", err
	}
	if err := tmp.Close(); err != nil {
		return "", err
	}

	got := hex.EncodeToString(h.Sum(nil))
	if got != wantSum {
		// The one check that must never be skipped: this file is about to be
		// executed as root on every node in the fleet.
		return "", fmt.Errorf("checksum mismatch: served %s, expected %s", got, wantSum)
	}
	if err := os.Chmod(tmpName, 0o755); err != nil {
		return "", err
	}

	staged := filepath.Join(stateDir, StagedName)
	if err := os.Rename(tmpName, staged); err != nil {
		return "", err
	}
	return staged, nil
}

// InstallStaged replaces the running binary with the one Stage left behind,
// and reports whether it did.
//
// The systemd unit does this in an ExecStartPre that runs as root, which is
// better where it exists. It does not exist on launchd: macOS nodes staged a
// verified binary that nothing ever installed, so the agent exited asking to
// be restarted, came back as the same version, staged again, and after
// MaxAttempts marked the upgrade failed and stayed on the old build for ever.
// Bounded rather than a loop, and completely silent — the one shape of bug
// this codebase is most prone to.
//
// Doing it here covers every supervisor, including none at all. Where the
// pre-start step already ran there is no staged file left and this is a no-op.
//
// The destination is os.Executable() rather than a configured directory: the
// binary that should be replaced is the one actually running, and a path
// written down somewhere else can be stale or simply wrong.
func InstallStaged(stateDir string) (bool, error) {
	staged := filepath.Join(stateDir, StagedName)
	info, err := os.Stat(staged)
	if err != nil {
		// Nothing staged is the overwhelmingly common case, and not an error.
		return false, nil
	}
	if info.Mode()&0o111 == 0 {
		return false, fmt.Errorf("%s is not executable", staged)
	}

	self, err := os.Executable()
	if err != nil {
		return false, err
	}
	// Through any symlink, so the real file is replaced rather than the link.
	if resolved, err := filepath.EvalSymlinks(self); err == nil {
		self = resolved
	}
	return installStagedInto(staged, self)
}

// installStagedInto is the part that can be tested without a test binary
// overwriting itself, which is what happens when the destination is always
// os.Executable().
func installStagedInto(staged, self string) (bool, error) {
	body, err := os.ReadFile(staged)
	if err != nil {
		return false, err
	}

	// Written beside the target and renamed over it, because rename is atomic
	// within a directory: a supervisor that restarts us mid-write must find
	// either the old binary or the new one, never half of either. Writing
	// directly to `self` would also fail with ETXTBSY on some systems.
	tmp := filepath.Join(filepath.Dir(self), "."+filepath.Base(self)+".new")
	if err := os.WriteFile(tmp, body, 0o755); err != nil {
		// The usual cause, and worth saying plainly: the agent runs
		// unprivileged and the binary belongs to root. An upgrade cannot
		// install itself into a directory the agent cannot write.
		return false, fmt.Errorf("write %s: %w", tmp, err)
	}
	if err := os.Rename(tmp, self); err != nil {
		os.Remove(tmp)
		return false, fmt.Errorf("replace %s: %w", self, err)
	}

	// Only now: while this file exists the upgrade is still owed.
	if err := os.Remove(staged); err != nil {
		return true, fmt.Errorf("installed, but could not remove %s: %w", staged, err)
	}
	return true, nil
}

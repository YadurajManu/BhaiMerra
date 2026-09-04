// Package state persists the node identity across agent restarts.
package state

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
)

// State is what the agent must remember. The token is a credential, so the
// file is written 0600 and lives outside any container mount.
type State struct {
	NodeID               string `json:"node_id"`
	FleetID              string `json:"fleet_id"`
	Name                 string `json:"name"`
	AgentToken           string `json:"agent_token"`
	ControlPlaneURL      string `json:"control_plane_url"`
	HeartbeatIntervalSec int    `json:"heartbeat_interval_sec"`

	// The build most recently staged for install, and how many times it has
	// been staged without becoming the running binary. Remembered across
	// restarts because that is the only way to tell "waiting for a restart"
	// from "the install is not working" - and without the difference, a broken
	// upgrade re-downloads the same bytes every reconcile forever.
	UpgradeStaged   string `json:"upgrade_staged,omitempty"`
	UpgradeAttempts int    `json:"upgrade_attempts,omitempty"`
}

func DefaultPath() string {
	if dir := os.Getenv("FLEET_STATE_DIR"); dir != "" {
		return filepath.Join(dir, "agent.json")
	}
	if runtime.GOOS == "windows" {
		if home, err := os.UserHomeDir(); err == nil {
			return filepath.Join(home, ".fleet-os", "agent.json")
		}
	} else if runtime.GOOS == "darwin" {
		if home, err := os.UserHomeDir(); err == nil {
			return filepath.Join(home, "Library", "Application Support", "fleet-os", "agent.json")
		}
	}
	// Matches the systemd unit shipped by the install script on Linux.
	return "/var/lib/fleet-os/agent.json"
}

func Load(path string) (*State, error) {
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil // not an error: this is a first run
	}
	if err != nil {
		return nil, fmt.Errorf("read state: %w", err)
	}
	var s State
	if err := json.Unmarshal(data, &s); err != nil {
		return nil, fmt.Errorf("parse state at %s: %w", path, err)
	}
	return &s, nil
}

func Save(path string, s *State) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return fmt.Errorf("create state dir: %w", err)
	}
	data, err := json.MarshalIndent(s, "", "  ")
	if err != nil {
		return fmt.Errorf("encode state: %w", err)
	}
	// Write-then-rename so a crash mid-write cannot leave a truncated file
	// that would strand the node with no usable credential.
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return fmt.Errorf("write state: %w", err)
	}
	if err := os.Rename(tmp, path); err != nil {
		return fmt.Errorf("commit state: %w", err)
	}
	return nil
}

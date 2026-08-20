// Command agent is the Fleet OS node agent.
//
// It registers a machine with a control plane, reports capability and health,
// and reconciles local containers toward the desired state the control plane
// hands it. It never makes placement decisions itself (tech doc §7).
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/fleet-os/fleet-os/agent/internal/capability"
	"github.com/fleet-os/fleet-os/agent/internal/client"
	"github.com/fleet-os/fleet-os/agent/internal/heartbeat"
	"github.com/fleet-os/fleet-os/agent/internal/sampler"
	"github.com/fleet-os/fleet-os/agent/internal/state"
)

// Version is stamped at build time: -ldflags "-X main.Version=0.1.0"
var Version = "dev"

func main() {
	if err := run(); err != nil && !errors.Is(err, context.Canceled) {
		fmt.Fprintf(os.Stderr, "fleet-agent: %v\n", err)
		os.Exit(1)
	}
}

func run() error {
	var (
		controlPlane = flag.String("control-plane", envOr("FLEET_CONTROL_PLANE", "https://api.fleet-os.dev"), "control plane base URL")
		pairingToken = flag.String("token", os.Getenv("FLEET_PAIRING_TOKEN"), "single-use pairing token (first run only)")
		statePath    = flag.String("state", state.DefaultPath(), "path to the agent state file")
		logLevel     = flag.String("log-level", envOr("FLEET_LOG_LEVEL", "info"), "debug|info|warn|error")
		showCaps     = flag.Bool("capabilities", false, "print detected capabilities as JSON and exit")
		registerOnly = flag.Bool("register-only", false, "pair with the control plane, write state, then exit")
		showVersion  = flag.Bool("version", false, "print version and exit")
	)
	flag.Parse()

	if *showVersion {
		fmt.Println(Version)
		return nil
	}

	log := newLogger(*logLevel)

	if *showCaps {
		// Useful on its own: run this before pairing to see what the control
		// plane is going to be told about the machine.
		return printJSON(capability.Detect(Version))
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	saved, err := state.Load(*statePath)
	if err != nil {
		return err
	}

	if saved == nil {
		saved, err = register(ctx, log, *controlPlane, *pairingToken, *statePath)
		if err != nil {
			return err
		}
	} else {
		log.Info("resuming as registered node", "node", saved.Name, "node_id", saved.NodeID)
	}

	// The installer pairs in the foreground so a bad token surfaces as an
	// error the user is still watching, then hands the loop to systemd.
	if *registerOnly {
		log.Info("register-only: state written, exiting", "node", saved.Name)
		return nil
	}

	api := client.New(saved.ControlPlaneURL, saved.AgentToken)

	interval := time.Duration(saved.HeartbeatIntervalSec) * time.Second
	if interval <= 0 {
		interval = 5 * time.Second
	}

	// Phase 1 ships without the Docker module wired in; the sampler treats a
	// nil lister as "no containers to report" rather than failing the beat.
	loop := &heartbeat.Loop{
		Client:   api,
		Sampler:  sampler.New(Version, nil),
		Interval: interval,
		Log:      log,
	}

	log.Info("agent started",
		"version", Version,
		"node", saved.Name,
		"control_plane", saved.ControlPlaneURL,
		"interval", interval)

	err = loop.Run(ctx)
	if errors.Is(err, context.Canceled) {
		log.Info("agent stopped")
		return nil
	}
	return err
}

func register(ctx context.Context, log *slog.Logger, controlPlane, token, statePath string) (*state.State, error) {
	if token == "" {
		return nil, errors.New(
			"no saved state and no pairing token: generate one in the dashboard and pass --token (or set FLEET_PAIRING_TOKEN)")
	}

	report := capability.Detect(Version)
	log.Info("detected capability",
		"arch", report.Arch, "cores", report.CPUCores,
		"ram_mb", report.RAMMb, "disk_mb", report.DiskMb, "gpu", report.GPU)

	registerCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()

	resp, err := client.New(controlPlane, token).Register(registerCtx, report)
	if err != nil {
		return nil, fmt.Errorf("register with control plane: %w", err)
	}

	saved := &state.State{
		NodeID:               resp.NodeID,
		FleetID:              resp.FleetID,
		Name:                 resp.Name,
		AgentToken:           resp.AgentToken,
		ControlPlaneURL:      controlPlane,
		HeartbeatIntervalSec: resp.HeartbeatIntervalSec,
	}
	// Persist before the first heartbeat: a crash between registering and
	// saving would strand a node the control plane thinks exists but which
	// can never prove who it is.
	if err := state.Save(statePath, saved); err != nil {
		return nil, err
	}

	log.Info("registered", "node", resp.Name, "node_id", resp.NodeID, "state_file", statePath)
	return saved, nil
}

func newLogger(level string) *slog.Logger {
	var l slog.Level
	if err := l.UnmarshalText([]byte(strings.ToLower(level))); err != nil {
		l = slog.LevelInfo
	}
	return slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: l}))
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

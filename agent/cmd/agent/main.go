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
	"github.com/fleet-os/fleet-os/agent/internal/diagnostics"
	"github.com/fleet-os/fleet-os/agent/internal/docker"
	"github.com/fleet-os/fleet-os/agent/internal/heartbeat"
	"github.com/fleet-os/fleet-os/agent/internal/reconcile"
	"github.com/fleet-os/fleet-os/agent/internal/sampler"
	"github.com/fleet-os/fleet-os/agent/internal/state"
	"github.com/fleet-os/fleet-os/agent/internal/tunnel"
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
		controlPlane = flag.String("control-plane", envOr("FLEET_CONTROL_PLANE", "https://fleetapi.plastikworld.xyz"), "control plane base URL")
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

	dockerClient := docker.New()
	reporter := diagnostics.New(dockerClient)
	engine := &reconcile.Engine{
		Docker: dockerClient,
		Client: api,
		NodeID: saved.NodeID,
		Log:    log,
	}

	// A node whose Docker is down is still a live node: it reports health and
	// stays in the fleet, it just cannot run workloads. Say so once at startup
	// rather than failing every reconcile in silence.
	if err := dockerClient.Ping(ctx); err != nil {
		log.Warn("container runtime unavailable — this node will report health but cannot run services", "err", err)
	} else {
		log.Info("container runtime ready")
	}

	loop := &heartbeat.Loop{
		Client:   api,
		Sampler:  sampler.New(Version, engine, reporter),
		Interval: interval,
		Log:      log,
	}

	// Reconciliation runs alongside the heartbeat rather than inside it, so a
	// slow image pull never delays liveness and get the node marked down.
	go runReconciler(ctx, engine, api, reporter, interval, log)

	// Reverse tunnel connects to the control plane and multiplexes incoming
	// HTTP ingress requests directly to local containers behind NAT/firewalls.
	tunnelClient := tunnel.New(saved.ControlPlaneURL, saved.AgentToken, log)
	go tunnelClient.Run(ctx)

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

// runReconciler polls desired state and converges the node toward it.
//
// Losing the control plane is not fatal (PRD §9): already-running containers
// keep serving, and the agent simply retries. It never stops workloads because
// it cannot reach the control plane.
func runReconciler(ctx context.Context, engine *reconcile.Engine, api *client.Client, reporter *diagnostics.Reporter, interval time.Duration, log *slog.Logger) {
	period := interval * 2
	if period < 5*time.Second {
		period = 5 * time.Second
	}

	ticker := time.NewTicker(period)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}

		desired, err := api.DesiredState(ctx)
		if err != nil {
			reporter.ObserveReconcile(nil, err)
			log.Debug("could not fetch desired state, keeping current workloads", "err", err)
			continue
		}

		actions, err := engine.Reconcile(ctx, desired)
		reporter.ObserveReconcile(actions, err)
		if err != nil {
			log.Warn("reconcile failed", "err", err)
			continue
		}
		logCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
		reporter.CaptureLogs(logCtx, desired)
		cancel()

		for _, a := range actions {
			if a.Verb == "unchanged" {
				continue // the steady state is not worth a log line every tick
			}
			if a.Verb == "failed" {
				log.Error("reconcile action failed", "service", a.Service, "detail", a.Detail)
				continue
			}
			log.Info("reconciled", "service", a.Service, "action", a.Verb, "detail", a.Detail)
		}
	}
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

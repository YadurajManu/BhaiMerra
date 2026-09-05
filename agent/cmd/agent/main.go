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
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"time"

	"github.com/fleet-os/fleet-os/agent/internal/backup"
	"github.com/fleet-os/fleet-os/agent/internal/capability"
	"github.com/fleet-os/fleet-os/agent/internal/client"
	"github.com/fleet-os/fleet-os/agent/internal/diagnostics"
	"github.com/fleet-os/fleet-os/agent/internal/docker"
	"github.com/fleet-os/fleet-os/agent/internal/health"
	"github.com/fleet-os/fleet-os/agent/internal/heartbeat"
	"github.com/fleet-os/fleet-os/agent/internal/reconcile"
	"github.com/fleet-os/fleet-os/agent/internal/sampler"
	"github.com/fleet-os/fleet-os/agent/internal/state"
	"github.com/fleet-os/fleet-os/agent/internal/tunnel"
	"github.com/fleet-os/fleet-os/agent/internal/upgrade"
)

// Version is stamped at build time: -ldflags "-X main.Version=0.1.0"
var Version = "dev"

// errUpgradeStaged is not a failure. It is the only way to ask a supervisor to
// restart us, which is what installs the binary waiting in the state
// directory.
var errUpgradeStaged = errors.New("a verified agent upgrade is staged")

func main() {
	err := run()
	if errors.Is(err, errUpgradeStaged) {
		// Non-zero on purpose: Restart=on-failure. See ExitUpgradeStaged.
		os.Exit(ExitUpgradeStaged)
	}
	if err != nil && !errors.Is(err, context.Canceled) {
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

	// Before anything else: a binary staged by a previous run is installed
	// here, and we restart onto it.
	//
	// On systemd the unit's ExecStartPre has already done this as root and
	// there is nothing left to find. launchd has no equivalent, so without
	// this a macOS node staged a verified upgrade that was never installed —
	// it restarted, came back the same version, staged again, and after
	// MaxAttempts gave up and stayed on the old build silently.
	if installed, err := upgrade.InstallStaged(filepath.Dir(*statePath)); err != nil {
		// Not fatal: an agent that cannot upgrade itself is still an agent
		// that works. But it must say so, because the alternative is a node
		// that quietly never updates again.
		log.Warn("could not install the staged upgrade — this node will keep running its current version", "err", err)
	} else if installed {
		log.Info("installed a staged upgrade, restarting onto it", "was", Version)
		return errUpgradeStaged
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

	// The auto-start decision is persisted alongside agent.json, so quitting
	// Docker survives the restarts the supervisor performs on its own.
	dockerClient := docker.New(filepath.Dir(*statePath))
	reporter := diagnostics.New(dockerClient)
	engine := &reconcile.Engine{
		Docker: dockerClient,
		Client: api,
		NodeID: saved.NodeID,
		Log:    log,
		// Health is decided here, on the node, rather than by a shell inside
		// each container — so it no longer depends on the user's base image
		// happening to contain wget or curl.
		Health:   health.New(),
		Discover: health.NewDiscoverer(),
	}

	// Volume backups. The control plane hands them over with the desired
	// state; this performs them and reports each outcome.
	backups := &backup.Runner{Docker: dockerClient, Report: api, Log: log}

	// A node whose Docker is down is still a live node: it reports health and
	// stays in the fleet, it just cannot run workloads. Say so once at startup
	// rather than failing every reconcile in silence.
	//
	// Report only — deliberately not PingOrStart. Startup looks like the
	// cold-start case but is not: the supervisor restarts this process on its
	// own, so a start here fires every time the agent is bounced, including in
	// a crash loop, and relaunches the Docker the operator just quit. Starting
	// the daemon belongs to reconciliation, which only runs once the agent is
	// alive, authenticated, and actually has a workload to place.
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
	go runReconciler(ctx, engine, api, backups, reporter, interval, log)

	// Reverse tunnel connects to the control plane and multiplexes incoming
	// HTTP ingress requests directly to local containers behind NAT/firewalls.
	tunnelClient := tunnel.New(saved.ControlPlaneURL, saved.AgentToken, log)
	go tunnelClient.Run(ctx)

	// Self-upgrade. Cancelling runCtx - and only runCtx - is how a staged
	// build stops the loop without being mistaken for a shutdown: the outer ctx
	// stays live, which is what distinguishes the two below.
	runCtx, stopForUpgrade := context.WithCancel(ctx)
	defer stopForUpgrade()
	stagedCh := make(chan struct{}, 1)
	go runUpgradeChecks(runCtx, api, saved, *statePath, log, stagedCh)
	go func() {
		select {
		case <-stagedCh:
			stopForUpgrade()
		case <-runCtx.Done():
		}
	}()

	log.Info("agent started",
		"version", Version,
		"node", saved.Name,
		"control_plane", saved.ControlPlaneURL,
		"interval", interval)

	err = loop.Run(runCtx)
	// An upgrade cancelled runCtx while the process is otherwise healthy; a
	// real shutdown cancels the outer ctx too. Only the first should restart.
	if ctx.Err() == nil && runCtx.Err() != nil {
		log.Info("restarting to install a staged upgrade")
		return errUpgradeStaged
	}
	if errors.Is(err, context.Canceled) {
		log.Info("agent stopped")
		return nil
	}

	// A rejected credential is terminal, and it must not become a restart loop.
	//
	// The supervisor brings the process straight back, the credential is still
	// rejected, and the cycle repeats every few seconds — each pass previously
	// relaunching Docker on the way through. Exiting 0 is how we tell both
	// supervisors to leave us alone: the systemd unit uses Restart=on-failure
	// and the launchd job KeepAlive/SuccessfulExit, so a clean exit stays exited.
	var apiErr *client.APIError
	if errors.As(err, &apiErr) && apiErr.Fatal() {
		log.Error("this node's credential was rejected — stopping instead of retrying",
			"status", apiErr.StatusCode,
			"detail", apiErr.Message,
			"fix", "the node was removed, or the control plane was reset; re-pair with the installer and --reset")
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
func runReconciler(ctx context.Context, engine *reconcile.Engine, api *client.Client, backups *backup.Runner, reporter *diagnostics.Reporter, interval time.Duration, log *slog.Logger) {
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

		// Backups run after reconciliation, never instead of it. Copying a few
		// gigabytes takes minutes, and a node that stopped keeping its
		// containers correct for the length of a backup would be trading the
		// live service for a copy of it.
		if len(desired.Backups) > 0 {
			jobs := make([]backup.Job, 0, len(desired.Backups))
			for _, b := range desired.Backups {
				jobs = append(jobs, backup.Job{ID: b.ID, Volume: b.Volume, Service: b.Service})
			}
			backups.Run(ctx, jobs)
		}

		// Restores last. The service is stopped for one — the control plane
		// refuses to queue it otherwise — so there is nothing to keep serving
		// while this runs, and doing it after reconciliation means the volume
		// is not being recreated underneath the write.
		if len(desired.Restores) > 0 {
			jobs := make([]backup.RestoreJob, 0, len(desired.Restores))
			for _, r := range desired.Restores {
				jobs = append(jobs, backup.RestoreJob{ID: r.ID, Volume: r.Volume, Service: r.Service})
			}
			backups.Restore(ctx, jobs)
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

// ExitUpgradeStaged tells the supervisor to restart us so a staged binary is
// installed.
//
// Deliberately non-zero: the unit is Restart=on-failure, because exit 0 means
// "the control plane rejected this credential" and restarting that produced a
// loop. A clean exit here would simply stop the agent, and the upgrade would
// land whenever somebody happened to reboot the machine.
const ExitUpgradeStaged = 70

// UpgradeCheckInterval is how often the agent asks whether it is the build
// being served.
//
// Half-hourly rather than per-reconcile: reconciliation runs every ten seconds
// and this reads the whole binary to hash it. An agent being one build behind
// for half an hour costs nothing; hashing seven megabytes every ten seconds on
// a Raspberry Pi is not nothing.
const UpgradeCheckInterval = 30 * time.Minute

/*
 * Replace this binary with the one the control plane serves.
 *
 * Returns true when a verified binary is waiting and the process should exit
 * so the supervisor can install it. Every failure is logged and returns false:
 * a node that cannot upgrade must keep running the version it has, because the
 * alternative is a fleet that goes down when a download does.
 */
// checkForUpgrade runs one check and says whether a build is staged and
// waiting for a restart.
//
// It logs exactly one line per check, at info, naming what it decided. That
// matters more than it looks: every branch below used to return quietly, at
// debug, and the opt-out branch said nothing at all -- so a node that could
// never upgrade (opted out, a bad URL, a revoked token) produced precisely the
// same silence as one that was already current. Finding out which required
// hashing binaries by hand against the published sums. A check that runs every
// half hour and says what it concluded costs 48 lines a day and removes a
// whole category of "is this even running?".
func checkForUpgrade(
	ctx context.Context,
	api *client.Client,
	saved *state.State,
	statePath string,
	log *slog.Logger,
) bool {
	staged, decision, fields := decideUpgrade(ctx, api, saved, statePath, log)
	log.Info("upgrade check", append([]any{"decision", decision}, fields...)...)
	return staged
}

// decideUpgrade is the check itself. Every path returns a decision word, so the
// caller can log one line without this function having to remember to.
func decideUpgrade(
	ctx context.Context,
	api *client.Client,
	saved *state.State,
	statePath string,
	log *slog.Logger,
) (bool, string, []any) {
	// The fleet has to have opted in. Checked here, on every attempt, so
	// turning it off in the dashboard stops the next one rather than only
	// applying to nodes that have not started yet.
	desired, err := api.DesiredState(ctx)
	if err != nil {
		// The control plane being unreachable is not an upgrade failure worth
		// shouting about; the heartbeat already reports that far more loudly.
		return false, "control_plane_unreachable", []any{"err", err}
	}
	if !desired.AgentAutoUpgrade {
		return false, "disabled_for_this_fleet", nil
	}

	self, err := os.Executable()
	if err != nil {
		return false, "cannot_locate_own_binary", []any{"err", err}
	}

	runningSum, err := upgrade.HashFile(self)
	if err != nil {
		return false, "cannot_hash_own_binary", []any{"err", err}
	}

	body, err := api.PublishedSums(ctx)
	if err != nil {
		return false, "no_published_checksums", []any{"err", err}
	}

	binary := upgrade.BinaryName(runtime.GOOS, runtime.GOARCH)
	publishedSum, err := upgrade.Published(upgrade.ParseSums(body), binary)
	if err != nil {
		return false, "no_build_for_this_platform", []any{"binary", binary}
	}

	st := upgrade.State{LastStaged: saved.UpgradeStaged, Attempts: saved.UpgradeAttempts}
	switch upgrade.Decide(runningSum, publishedSum, st) {
	case upgrade.UpToDate:
		return false, "up_to_date", []any{"build", runningSum[:12]}

	case upgrade.AlreadyStaged:
		// Staged but still running the old binary: the restart has not happened
		// yet. Count it, so a swap that silently does nothing is eventually
		// recognised rather than retried forever.
		saved.UpgradeAttempts++
		if err := state.Save(statePath, saved); err != nil {
			log.Warn("could not record upgrade attempt", "err", err)
		}
		return false, "staged_awaiting_restart", []any{
			"attempts", saved.UpgradeAttempts, "build", publishedSum[:12],
		}

	case upgrade.Failed:
		log.Warn("staged build is not being installed — leaving this node on its current version",
			"build", publishedSum[:12], "attempts", saved.UpgradeAttempts,
			"hint", "the service unit may predate self-upgrade; re-run install.sh --configure")
		return false, "staged_build_never_installed", []any{"build", publishedSum[:12]}
	}

	log.Info("a newer agent is published, downloading",
		"binary", binary, "from", runningSum[:12], "to", publishedSum[:12])

	rc, err := api.DownloadAgent(ctx, binary)
	if err != nil {
		log.Warn("agent download failed, staying on the current version", "err", err)
		return false, "download_failed", []any{"err", err}
	}
	defer rc.Close()

	if _, err := upgrade.Stage(filepath.Dir(statePath), rc, publishedSum); err != nil {
		// Includes the checksum mismatch, which is the one that matters: a
		// binary that does not match what was published is never staged.
		log.Warn("agent upgrade rejected, staying on the current version", "err", err)
		return false, "rejected_before_staging", []any{"err", err}
	}

	saved.UpgradeStaged = publishedSum
	saved.UpgradeAttempts = 1
	if err := state.Save(statePath, saved); err != nil {
		// Without this the agent would forget it staged anything and download
		// the same bytes on the next tick, forever.
		log.Warn("could not record staged upgrade", "err", err)
		return false, "staged_but_not_recorded", []any{"err", err}
	}

	log.Info("verified and staged; restarting to install", "build", publishedSum[:12])
	return true, "staged", []any{"from", runningSum[:12], "to", publishedSum[:12]}
}

func runUpgradeChecks(
	ctx context.Context,
	api *client.Client,
	saved *state.State,
	statePath string,
	log *slog.Logger,
	staged chan<- struct{},
) {
	// Once shortly after start, so a node that has been offline picks up a
	// waiting build without waiting out a whole interval - but not instantly,
	// so a crash-looping agent does not download on every restart.
	timer := time.NewTimer(2 * time.Minute)
	defer timer.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-timer.C:
		}
		if checkForUpgrade(ctx, api, saved, statePath, log) {
			select {
			case staged <- struct{}{}:
			default:
			}
			return
		}
		timer.Reset(UpgradeCheckInterval)
	}
}

// Package backup copies a Docker volume off the node it lives on.
//
// A volume is the one thing Fleet cannot reproduce. An image rebuilds from a
// commit and a container recreates from a manifest, but the bytes in a
// database's data directory exist on exactly one disk. Until this, there was
// no way to get a copy of them anywhere else.
//
// The copy is made by the node itself, because only the node can read its own
// disk — the control plane never reaches into one, which is the whole reason
// agents are outbound-only. The archive is then uploaded over the same
// authenticated channel everything else uses.
package backup

import (
	"bytes"
	"context"
	"fmt"
	"time"

	"github.com/fleet-os/fleet-os/agent/internal/docker"
)

// Job is one backup the control plane is waiting for.
type Job struct {
	ID      string `json:"id"`
	Volume  string `json:"volume"`
	Service string `json:"service"`
}

// Reporter is the control-plane side of a backup, so this package can be
// tested without one.
type Reporter interface {
	ClaimBackup(ctx context.Context, id string) error
	UploadBackup(ctx context.Context, id string, archive []byte) error
	FailBackup(ctx context.Context, id string, reason string) error
}

// Runner performs backup jobs against a Docker daemon.
type Runner struct {
	Docker *docker.Client
	Report Reporter
	Log    interface {
		Info(msg string, args ...any)
		Warn(msg string, args ...any)
	}
	// Image used to read the volume. Something tiny with tar in it; the node
	// may well have it already from another service.
	Image string
	// How long one archive may take. A large volume over a slow disk is
	// genuinely slow, and cutting it short leaves a partial archive that looks
	// like a backup.
	Timeout time.Duration
}

const defaultImage = "alpine:3.20"
const defaultTimeout = 20 * time.Minute

// Run performs every job it is given, reporting each one's outcome.
//
// A failure is reported and the next job is attempted: one unreadable volume
// should not stop the others, and a job whose failure was never reported would
// sit `running` until the control plane timed it out with nothing to say.
func (r *Runner) Run(ctx context.Context, jobs []Job) {
	for _, job := range jobs {
		if err := r.one(ctx, job); err != nil {
			r.logWarn("backup failed", "service", job.Service, "volume", job.Volume, "err", err)
			// Best effort: if this cannot be delivered either, the stall
			// sweeper on the control plane closes the row out.
			reportCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
			_ = r.Report.FailBackup(reportCtx, job.ID, err.Error())
			cancel()
		}
	}
}

func (r *Runner) one(ctx context.Context, job Job) error {
	// Claimed first, so a job that dies mid-archive is distinguishable from
	// one the node never picked up.
	if err := r.Report.ClaimBackup(ctx, job.ID); err != nil {
		return fmt.Errorf("claim: %w", err)
	}

	timeout := r.Timeout
	if timeout <= 0 {
		timeout = defaultTimeout
	}
	runCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	image := r.Image
	if image == "" {
		image = defaultImage
	}

	started := time.Now()
	archive, err := r.Docker.ArchiveVolume(runCtx, job.Volume, image)
	if err != nil {
		return fmt.Errorf("archive volume %q: %w", job.Volume, err)
	}
	if len(archive) == 0 {
		return fmt.Errorf("archive of volume %q was empty", job.Volume)
	}

	r.logInfo("volume archived",
		"service", job.Service, "volume", job.Volume,
		"bytes", len(archive), "took", time.Since(started).Round(time.Millisecond))

	// Uploaded on a fresh deadline: the archive already exists, and losing it
	// because the read took most of the window would waste all of that work.
	upCtx, upCancel := context.WithTimeout(ctx, timeout)
	defer upCancel()
	if err := r.Report.UploadBackup(upCtx, job.ID, archive); err != nil {
		return fmt.Errorf("upload: %w", err)
	}

	r.logInfo("backup uploaded", "service", job.Service, "bytes", len(archive))
	return nil
}

func (r *Runner) logInfo(msg string, args ...any) {
	if r.Log != nil {
		r.Log.Info(msg, args...)
	}
}

func (r *Runner) logWarn(msg string, args ...any) {
	if r.Log != nil {
		r.Log.Warn(msg, args...)
	}
}

// Compile-time proof that a bytes.Buffer is not accidentally required.
var _ = bytes.MinRead

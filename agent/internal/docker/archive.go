package docker

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
)

// ArchiveVolume returns a gzipped tar of everything in a named volume.
//
// The trick is that no container has to *run*. Docker will copy a path out of
// a container that was only ever created, so a container is created with the
// volume mounted, its contents are read through the archive endpoint, and it
// is removed. Nothing is executed inside it, which means no shell, no tar
// binary, and nothing that can misbehave while a database is live on the other
// side of the same volume.
//
// The image is the one the service already runs. It is guaranteed present on
// this node — the service is running from it — so a backup never waits on a
// pull, which on the kind of connection these nodes have is most of the time
// a backup would otherwise take.
func (c *Client) ArchiveVolume(ctx context.Context, volume, image string) ([]byte, error) {
	const mountPath = "/fleet-backup"

	create := struct {
		Image      string            `json:"Image"`
		Labels     map[string]string `json:"Labels"`
		HostConfig hostConfig        `json:"HostConfig"`
	}{
		Image: image,
		// Labelled like everything else the agent owns, so a container left
		// behind by a crash is cleaned up as ours rather than lingering as an
		// unexplained stopped container.
		Labels: map[string]string{LabelManaged: "true", LabelService: "fleet-backup"},
		HostConfig: hostConfig{
			// Read-only: the service is still using this volume, and a backup
			// must not be able to alter what it is copying.
			Mounts: []mount{{Type: "volume", Source: volume, Target: mountPath, ReadOnly: true}},
		},
	}

	var created struct {
		ID string `json:"Id"`
	}
	if err := c.do(ctx, http.MethodPost, "/"+c.api(ctx)+"/containers/create", create, &created); err != nil {
		return nil, fmt.Errorf("create reader container: %w", err)
	}
	// Always removed, including on the error paths below.
	defer func() {
		cleanup, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		_ = c.Remove(cleanup, created.ID)
	}()

	path := fmt.Sprintf("/%s/containers/%s/archive?path=%s", c.api(ctx), created.ID, mountPath)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "http://docker"+path, nil)
	if err != nil {
		return nil, err
	}

	resp, err := c.http.Do(req)
	if err != nil {
		return nil, fmt.Errorf("read volume %q: %w", volume, err)
	}
	defer resp.Body.Close()

	if resp.StatusCode >= 400 {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
		var apiErr struct {
			Message string `json:"message"`
		}
		_ = json.Unmarshal(body, &apiErr)
		msg := apiErr.Message
		if msg == "" {
			msg = string(bytes.TrimSpace(body))
		}
		return nil, &Error{StatusCode: resp.StatusCode, Message: msg}
	}

	// Docker hands back an uncompressed tar. Compressing here rather than on
	// the control plane means the bytes crossing the network are the small
	// ones — these nodes are on domestic and college links, and a database
	// volume compresses well.
	var out bytes.Buffer
	zw := gzip.NewWriter(&out)
	if _, err := io.Copy(zw, resp.Body); err != nil {
		return nil, fmt.Errorf("read archive stream: %w", err)
	}
	if err := zw.Close(); err != nil {
		return nil, fmt.Errorf("finish archive: %w", err)
	}
	return out.Bytes(), nil
}

// ExtractToVolume writes a gzipped tar back into a named volume.
//
// The mirror of ArchiveVolume, and the same trick: nothing runs inside the
// container. Docker will extract an archive into a container that was only
// ever created, so the volume is mounted writable into a created container,
// the tar is pushed in through the archive endpoint, and the container is
// removed.
//
// The archive's entries are rooted at the mount path — that is how
// ArchiveVolume produced them — so extracting at "/" puts every file exactly
// where it came from.
//
// Extraction merges rather than replaces: files present in the volume but
// absent from the archive survive. Clearing first would need a shell in the
// container, and running one over a data directory is a far worse risk than a
// stale file. Restore into a fresh volume when that matters.
func (c *Client) ExtractToVolume(ctx context.Context, volume string, archive io.Reader) error {
	const mountPath = "/fleet-backup"

	create := struct {
		Image      string            `json:"Image"`
		Labels     map[string]string `json:"Labels"`
		HostConfig hostConfig        `json:"HostConfig"`
	}{
		Image:  c.restoreImage(),
		Labels: map[string]string{LabelManaged: "true", LabelService: "fleet-restore"},
		HostConfig: hostConfig{
			Mounts: []mount{{Type: "volume", Source: volume, Target: mountPath}},
		},
	}

	var created struct {
		ID string `json:"Id"`
	}
	if err := c.do(ctx, http.MethodPost, "/"+c.api(ctx)+"/containers/create", create, &created); err != nil {
		return fmt.Errorf("create writer container: %w", err)
	}
	defer func() {
		cleanup, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		_ = c.Remove(cleanup, created.ID)
	}()

	zr, err := gzip.NewReader(archive)
	if err != nil {
		return fmt.Errorf("archive is not gzip: %w", err)
	}
	defer zr.Close()

	path := fmt.Sprintf("/%s/containers/%s/archive?path=/", c.api(ctx), created.ID)
	req, err := http.NewRequestWithContext(ctx, http.MethodPut, "http://docker"+path, zr)
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/x-tar")

	resp, err := c.http.Do(req)
	if err != nil {
		return fmt.Errorf("write volume %q: %w", volume, err)
	}
	defer resp.Body.Close()

	if resp.StatusCode >= 400 {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
		var apiErr struct {
			Message string `json:"message"`
		}
		_ = json.Unmarshal(body, &apiErr)
		msg := apiErr.Message
		if msg == "" {
			msg = string(bytes.TrimSpace(body))
		}
		return &Error{StatusCode: resp.StatusCode, Message: msg}
	}
	return nil
}

// restoreImage is any image already on this node. A restore happens while the
// service is stopped, so its own image is present but not running — which
// makes it the one thing guaranteed to exist without a pull.
func (c *Client) restoreImage() string {
	if c.RestoreImage != "" {
		return c.RestoreImage
	}
	return "alpine:3.20"
}

package docker

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
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
		cleanup, cancel := context.WithTimeout(context.Background(), 30_000_000_000)
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

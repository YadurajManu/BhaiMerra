package docker

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"time"
)

// RunSpec is everything needed to bring one service up on this node.
type RunSpec struct {
	Service      string
	DeploymentID string
	NodeID       string
	Image        string
	Env          map[string]string
	Ports        map[string]string // container port "8080/tcp" -> host port
	Volume       string            // named volume mounted at VolumePath
	VolumePath   string
	HealthPath   string
	Memory       int64 // bytes; 0 means unlimited
}

// ContainerName is deterministic so reconciliation can find what it created
// after an agent restart, without keeping its own index.
func ContainerName(service string) string { return "fleet-" + service }

type pullStatus struct {
	Error string `json:"error"`
}

// Pull fetches an image, streaming progress to /dev/null but surfacing any
// error the daemon reports mid-stream — a pull can fail after a 200.
func (c *Client) Pull(ctx context.Context, image string, auth string) error {
	ref, tag := splitTag(image)
	path := fmt.Sprintf("/%s/images/create?fromImage=%s&tag=%s", c.api(ctx), url.QueryEscape(ref), url.QueryEscape(tag))

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, "http://docker"+path, nil)
	if err != nil {
		return err
	}
	if auth != "" {
		req.Header.Set("X-Registry-Auth", base64.URLEncoding.EncodeToString([]byte(auth)))
	}

	resp, err := c.http.Do(req)
	if err != nil {
		return fmt.Errorf("pull %s: %w", image, err)
	}
	defer resp.Body.Close()

	if resp.StatusCode >= 400 {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
		return &Error{StatusCode: resp.StatusCode, Message: strings.TrimSpace(string(body))}
	}

	// The daemon returns 200 then streams JSON lines; a failure partway
	// through appears only in the stream.
	decoder := json.NewDecoder(resp.Body)
	for {
		var line pullStatus
		if err := decoder.Decode(&line); err != nil {
			if err == io.EOF {
				return nil
			}
			return fmt.Errorf("pull %s: reading progress: %w", image, err)
		}
		if line.Error != "" {
			return fmt.Errorf("pull %s: %s", image, line.Error)
		}
	}
}

func splitTag(image string) (string, string) {
	// Only split on a colon after the last slash, so a registry port
	// (registry:5000/img) is not mistaken for a tag.
	slash := strings.LastIndex(image, "/")
	colon := strings.LastIndex(image, ":")
	if colon > slash {
		return image[:colon], image[colon+1:]
	}
	return image, "latest"
}

type createRequest struct {
	Image        string              `json:"Image"`
	Env          []string            `json:"Env,omitempty"`
	Labels       map[string]string   `json:"Labels"`
	ExposedPorts map[string]struct{} `json:"ExposedPorts,omitempty"`
	HostConfig   hostConfig          `json:"HostConfig"`
	Healthcheck  *healthcheck        `json:"Healthcheck,omitempty"`
}

type healthcheck struct {
	Test     []string `json:"Test"`
	Interval int64    `json:"Interval"`
	Timeout  int64    `json:"Timeout"`
	Retries  int      `json:"Retries"`
}

type portBinding struct {
	HostIP   string `json:"HostIp"`
	HostPort string `json:"HostPort"`
}

type mount struct {
	Type   string `json:"Type"`
	Source string `json:"Source"`
	Target string `json:"Target"`
}

type hostConfig struct {
	RestartPolicy struct {
		Name string `json:"Name"`
	} `json:"RestartPolicy"`
	PortBindings map[string][]portBinding `json:"PortBindings,omitempty"`
	Mounts       []mount                  `json:"Mounts,omitempty"`
	Memory       int64                    `json:"Memory,omitempty"`
}

type createResponse struct {
	ID       string   `json:"Id"`
	Warnings []string `json:"Warnings"`
}

// Create makes the container but does not start it.
func (c *Client) Create(ctx context.Context, spec RunSpec) (string, error) {
	req := createRequest{
		Image: spec.Image,
		Labels: map[string]string{
			LabelManaged:    "true",
			LabelService:    spec.Service,
			LabelDeployment: spec.DeploymentID,
			LabelNode:       spec.NodeID,
		},
		HostConfig: hostConfig{Memory: spec.Memory},
	}
	// The agent may be restarting, or the node rebooting; the workload should
	// come back without waiting for the control plane to notice.
	req.HostConfig.RestartPolicy.Name = "unless-stopped"

	// Sorted, because Go randomises map iteration and an unordered Env makes
	// two identical specs produce two different create requests — which is
	// impossible to assert on in a test and confusing to read in a diff.
	if len(spec.Env) > 0 {
		keys := make([]string, 0, len(spec.Env))
		for k := range spec.Env {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		req.Env = make([]string, 0, len(keys))
		for _, k := range keys {
			req.Env = append(req.Env, k+"="+spec.Env[k])
		}
	}

	if len(spec.Ports) > 0 {
		req.ExposedPorts = map[string]struct{}{}
		req.HostConfig.PortBindings = map[string][]portBinding{}
		for containerPort, hostPort := range spec.Ports {
			req.ExposedPorts[containerPort] = struct{}{}
			req.HostConfig.PortBindings[containerPort] = []portBinding{{HostIP: "0.0.0.0", HostPort: hostPort}}
		}
	}

	if spec.Volume != "" {
		target := spec.VolumePath
		if target == "" {
			target = "/data"
		}
		req.HostConfig.Mounts = []mount{{Type: "volume", Source: spec.Volume, Target: target}}
	}

	var out createResponse
	path := fmt.Sprintf("/%s/containers/create?name=%s", c.api(ctx), url.QueryEscape(ContainerName(spec.Service)))
	if err := c.do(ctx, http.MethodPost, path, req, &out); err != nil {
		return "", err
	}
	return out.ID, nil
}

func (c *Client) Start(ctx context.Context, nameOrID string) error {
	return c.do(ctx, http.MethodPost, "/"+c.api(ctx)+"/containers/"+nameOrID+"/start", nil, nil)
}

// Stop asks politely, then the daemon kills it after the grace period.
func (c *Client) Stop(ctx context.Context, nameOrID string, grace time.Duration) error {
	seconds := int(grace.Seconds())
	if seconds <= 0 {
		seconds = 10
	}
	path := fmt.Sprintf("/%s/containers/%s/stop?t=%d", c.api(ctx), nameOrID, seconds)
	err := c.do(ctx, http.MethodPost, path, nil, nil)
	if IsNotFound(err) {
		return nil
	}
	// 304 means it was already stopped, which is the state we wanted.
	var de *Error
	if asError(err, &de) && de.StatusCode == http.StatusNotModified {
		return nil
	}
	return err
}

func (c *Client) Remove(ctx context.Context, nameOrID string) error {
	path := fmt.Sprintf("/%s/containers/%s?force=true&v=false", c.api(ctx), nameOrID)
	err := c.do(ctx, http.MethodDelete, path, nil, nil)
	if IsNotFound(err) {
		return nil // already gone is the desired state
	}
	return err
}

// Logs returns the tail of a container's output, de-multiplexed from Docker's
// framed stream format.
func (c *Client) Logs(ctx context.Context, nameOrID string, tail int) (string, error) {
	if tail <= 0 {
		tail = 200
	}
	path := fmt.Sprintf("/%s/containers/%s/logs?stdout=1&stderr=1&tail=%d", c.api(ctx), nameOrID, tail)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "http://docker"+path, nil)
	if err != nil {
		return "", err
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<16))
		return "", &Error{StatusCode: resp.StatusCode, Message: string(body)}
	}
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return "", err
	}
	return demultiplex(raw), nil
}

// demultiplex strips Docker's 8-byte stream headers. Without this the log
// output is peppered with control bytes.
func demultiplex(raw []byte) string {
	var out strings.Builder
	for len(raw) >= 8 {
		size := int(raw[4])<<24 | int(raw[5])<<16 | int(raw[6])<<8 | int(raw[7])
		if size < 0 || 8+size > len(raw) {
			// Not framed (a TTY container writes raw bytes) — take the rest.
			out.Write(raw)
			return out.String()
		}
		out.Write(raw[8 : 8+size])
		raw = raw[8+size:]
	}
	return out.String()
}

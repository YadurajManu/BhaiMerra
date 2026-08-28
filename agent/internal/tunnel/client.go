package tunnel

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

type TunnelRequest struct {
	Type    string            `json:"type"`
	ID      string            `json:"id"`
	Port    int               `json:"port"`
	Method  string            `json:"method"`
	Path    string            `json:"path"`
	Headers map[string]string `json:"headers"`
	Body    string            `json:"body,omitempty"` // base64
}

type TunnelResponse struct {
	Type    string            `json:"type"`
	ID      string            `json:"id"`
	Status  int               `json:"status"`
	Headers map[string]string `json:"headers"`
	Body    string            `json:"body,omitempty"` // base64
	Error   string            `json:"error,omitempty"`
}

// Keepalive timings. Both ends ping, because both failures are real: the control
// plane needs to know it is routing ingress to a live tunnel, and we need to know
// our socket has not been quietly dropped by whatever NAT we sit behind. A socket
// whose mapping has expired stays open on both ends and never delivers anything,
// so silence is the only signal available.
const (
	// Shorter than the idle timeout of the NATs and stateful firewalls agents
	// commonly sit behind, so this also keeps the mapping from expiring.
	pingPeriod = 25 * time.Second
	// Must stay longer than the control plane's ping period (25s) or a healthy
	// but idle tunnel would tear itself down on schedule.
	pongWait = 70 * time.Second
	// Control frames are tiny; if one cannot go out in this long the socket is
	// not usable anyway.
	writeWait = 10 * time.Second
	// Response bodies are not tiny, and an upload on a slow uplink is allowed to
	// take its time — but not forever, which is what no deadline at all meant.
	dataWriteWait = 60 * time.Second
)

type Client struct {
	controlPlaneURL string
	agentToken      string
	log             *slog.Logger
	httpClient      *http.Client
	mu              sync.Mutex
	conn            *websocket.Conn
}

func New(controlPlaneURL, agentToken string, log *slog.Logger) *Client {
	return &Client{
		controlPlaneURL: controlPlaneURL,
		agentToken:      agentToken,
		log:             log,
		httpClient: &http.Client{
			Timeout: 30 * time.Second,
		},
	}
}

func (c *Client) Run(ctx context.Context) {
	wsURL := c.buildWsURL()

	for {
		select {
		case <-ctx.Done():
			return
		default:
		}

		c.log.Info("connecting reverse tunnel to control plane", "url", wsURL)
		err := c.connectAndServe(ctx, wsURL)
		if err != nil && !strings.Contains(err.Error(), "context canceled") {
			c.log.Warn("reverse tunnel disconnected, retrying in 3s", "err", err)
		}

		select {
		case <-ctx.Done():
			return
		case <-time.After(3 * time.Second):
		}
	}
}

func (c *Client) buildWsURL() string {
	base := strings.TrimRight(c.controlPlaneURL, "/")
	if strings.HasPrefix(base, "https://") {
		return "wss://" + strings.TrimPrefix(base, "https://") + "/agent/tunnel"
	}
	if strings.HasPrefix(base, "http://") {
		return "ws://" + strings.TrimPrefix(base, "http://") + "/agent/tunnel"
	}
	return "wss://" + base + "/agent/tunnel"
}

func (c *Client) connectAndServe(ctx context.Context, wsURL string) error {
	header := http.Header{}
	header.Set("Authorization", "Bearer "+c.agentToken)

	dialer := websocket.Dialer{
		HandshakeTimeout: 10 * time.Second,
	}

	conn, _, err := dialer.DialContext(ctx, wsURL, header)
	if err != nil {
		return fmt.Errorf("dial tunnel: %w", err)
	}
	defer conn.Close()

	c.mu.Lock()
	c.conn = conn
	c.mu.Unlock()

	// Stop writing responses to a socket we have already left, which otherwise
	// happens for any request still in flight when the tunnel drops.
	defer func() {
		c.mu.Lock()
		if c.conn == conn {
			c.conn = nil
		}
		c.mu.Unlock()
	}()

	// Silence past pongWait means the socket is gone, whatever the OS thinks.
	// Every ping and pong pushes the deadline out again.
	_ = conn.SetReadDeadline(time.Now().Add(pongWait))
	conn.SetPongHandler(func(string) error {
		return conn.SetReadDeadline(time.Now().Add(pongWait))
	})
	// Replaces gorilla's default ping handler, which replies but does not extend
	// the read deadline — without this a tunnel that is idle apart from the
	// control plane's own pings would hit the deadline and reconnect every 70s.
	conn.SetPingHandler(func(appData string) error {
		_ = conn.SetReadDeadline(time.Now().Add(pongWait))
		// WriteControl is the one write method safe to use concurrently with the
		// response writer, so this needs no lock.
		err := conn.WriteControl(websocket.PongMessage, []byte(appData), time.Now().Add(writeWait))
		if err == websocket.ErrCloseSent {
			return nil
		}
		return err
	})

	stop := make(chan struct{})
	defer close(stop)
	go func() {
		ticker := time.NewTicker(pingPeriod)
		defer ticker.Stop()
		for {
			select {
			case <-stop:
				return
			case <-ctx.Done():
				// Unblock the read loop rather than let shutdown wait out the
				// read deadline.
				_ = conn.Close()
				return
			case <-ticker.C:
				if err := conn.WriteControl(websocket.PingMessage, nil, time.Now().Add(writeWait)); err != nil {
					// Close so the read loop returns now and reconnects, instead
					// of sitting on a socket we already know is broken.
					_ = conn.Close()
					return
				}
			}
		}
	}()

	c.log.Info("reverse tunnel established successfully")

	for {
		_, message, err := conn.ReadMessage()
		if err != nil {
			return fmt.Errorf("read message: %w", err)
		}

		var req TunnelRequest
		if err := json.Unmarshal(message, &req); err != nil {
			continue
		}

		if req.Type == "http_request" {
			go c.handleHttpRequest(&req)
		}
	}
}

func (c *Client) handleHttpRequest(req *TunnelRequest) {
	targetURL := fmt.Sprintf("http://127.0.0.1:%d%s", req.Port, req.Path)

	var reqBody io.Reader
	if req.Body != "" {
		decoded, err := base64.StdEncoding.DecodeString(req.Body)
		if err == nil {
			reqBody = bytes.NewReader(decoded)
		}
	}

	httpReq, err := http.NewRequest(req.Method, targetURL, reqBody)
	if err != nil {
		c.sendResponse(&TunnelResponse{
			Type:   "http_response",
			ID:     req.ID,
			Status: http.StatusInternalServerError,
			Error:  err.Error(),
		})
		return
	}

	for k, v := range req.Headers {
		// Go builds the outgoing Host from the URL and ignores this header, so
		// setting it like the rest would leave the container seeing
		// "127.0.0.1:32768" as the name it was asked for — and building its
		// redirects and absolute URLs from that. The direct ingress path passes
		// the real Host through, so this one has to as well.
		if strings.EqualFold(k, "host") {
			httpReq.Host = v
			continue
		}
		httpReq.Header.Set(k, v)
	}

	res, err := c.httpClient.Do(httpReq)
	if err != nil {
		c.sendResponse(&TunnelResponse{
			Type:   "http_response",
			ID:     req.ID,
			Status: http.StatusBadGateway,
			Error:  err.Error(),
		})
		return
	}
	defer res.Body.Close()

	bodyBytes, _ := io.ReadAll(res.Body)
	respHeaders := make(map[string]string)
	for k, v := range res.Header {
		if len(v) > 0 {
			respHeaders[k] = v[0]
		}
	}

	c.sendResponse(&TunnelResponse{
		Type:    "http_response",
		ID:      req.ID,
		Status:  res.StatusCode,
		Headers: respHeaders,
		Body:    base64.StdEncoding.EncodeToString(bodyBytes),
	})
}

func (c *Client) sendResponse(resp *TunnelResponse) {
	c.mu.Lock()
	defer c.mu.Unlock()

	if c.conn == nil {
		return
	}

	payload, err := json.Marshal(resp)
	if err != nil {
		return
	}

	_ = c.conn.SetWriteDeadline(time.Now().Add(dataWriteWait))
	_ = c.conn.WriteMessage(websocket.TextMessage, payload)
}

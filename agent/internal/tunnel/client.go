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

	_ = c.conn.WriteMessage(websocket.TextMessage, payload)
}

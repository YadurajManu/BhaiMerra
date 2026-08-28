import { WebSocketServer, WebSocket } from 'ws'
import type { FastifyInstance } from 'fastify'
import type { AppContext } from '../api/context.js'
import { nodes } from '../db/schema.js'
import { eq } from 'drizzle-orm'
import { hashToken, isAgentToken } from '../lib/tokens.js'
import { randomUUID } from 'node:crypto'

export interface TunnelRequest {
  type: 'http_request'
  id: string
  port: number
  method: string
  path: string
  headers: Record<string, string>
  body?: string // base64
}

export interface TunnelResponse {
  type: 'http_response'
  id: string
  status: number
  headers: Record<string, string>
  body?: string // base64
  error?: string
}

type PendingRequest = {
  /** Which node this request is waiting on, so a closing tunnel can fail only its own. */
  nodeId: string
  resolve: (res: TunnelResponse) => void
  reject: (err: Error) => void
  timer: NodeJS.Timeout
}

/**
 * How often to ping an idle tunnel, and how long to wait for the pong.
 *
 * 25s is chosen to sit under the idle timeout of the NATs and load balancers
 * agents sit behind, which are commonly 30-60s — the ping is as much about
 * keeping the mapping alive as about detecting that it is gone.
 *
 * The agent's own read deadline must stay longer than this period, or a healthy
 * but idle tunnel tears itself down on schedule. See agent/internal/tunnel.
 */
const PING_PERIOD_MS = 25_000

/** Just enough of Fastify's logger to report a tunnel dying, passed in by the caller. */
type TunnelLogger = { warn: (obj: unknown, msg: string) => void }

export class TunnelRegistry {
  private sockets = new Map<string, WebSocket>()
  private pending = new Map<string, PendingRequest>()

  constructor(private ctx: AppContext) {}

  /**
   * Is this node reachable through a tunnel right now?
   *
   * `readyState` alone cannot answer that: a socket whose NAT mapping has expired
   * stays OPEN on both ends and simply never delivers anything, so ingress would
   * keep choosing a tunnel that swallows every request until the 30s timeout. The
   * keepalive below is what makes this answer trustworthy — it terminates a
   * socket that stops answering pings, which flips this to false and lets ingress
   * fall back to a direct connection.
   */
  public has(nodeId: string): boolean {
    const ws = this.sockets.get(nodeId)
    return Boolean(ws && ws.readyState === WebSocket.OPEN)
  }

  /**
   * Ping an idle tunnel and terminate it if it stops answering.
   *
   * Returns a stop function; the caller must call it on close, or the interval
   * outlives the socket it was watching.
   */
  private startKeepalive(nodeId: string, ws: WebSocket, log?: TunnelLogger): () => void {
    let awaitingPong = false

    const timer = setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN) {
        clearInterval(timer)
        return
      }
      if (awaitingPong) {
        // A full period with no reply. As far as the OS is concerned this socket
        // is fine, which is precisely the failure readyState cannot see, so take
        // it down hard — `close()` waits for a peer that is not listening.
        clearInterval(timer)
        log?.warn({ nodeId }, 'reverse tunnel stopped answering pings, terminating')
        ws.terminate()
        return
      }
      awaitingPong = true
      try {
        ws.ping()
      } catch {
        clearInterval(timer)
        ws.terminate()
      }
    }, PING_PERIOD_MS)

    ws.on('pong', () => {
      awaitingPong = false
    })

    return () => clearInterval(timer)
  }

  /**
   * Drop a node's tunnel.
   *
   * Revoking a node's credentials does not close a socket that is already
   * open (ADR 0001) — the tunnel was authenticated once at upgrade time and
   * never re-checked, so ingress could keep reaching a removed node until it
   * happened to disconnect. Called when a node is removed from a fleet.
   *
   * 1000 (normal closure) rather than an error code so the agent's reconnect
   * loop can tell "you are no longer part of this fleet" from a transient
   * network fault; its next connect attempt fails auth and stops for good.
   */
  public close(nodeId: string): boolean {
    const ws = this.sockets.get(nodeId)
    this.sockets.delete(nodeId)
    if (!ws) return false

    // Anything still waiting on this node will never be answered. Fail those
    // now rather than leaving the caller to the 30s timeout — but only this
    // node's, since the pending map is shared across every tunnel.
    for (const [id, handler] of this.pending) {
      if (handler.nodeId !== nodeId) continue
      clearTimeout(handler.timer)
      this.pending.delete(id)
      handler.reject(new Error(`Node ${nodeId} was removed from the fleet`))
    }

    try {
      ws.close(1000, 'node removed from fleet')
    } catch {
      ws.terminate()
    }
    return true
  }

  public register(nodeId: string, ws: WebSocket, log?: TunnelLogger) {
    // Close existing socket if any
    const existing = this.sockets.get(nodeId)
    if (existing && existing !== ws) {
      existing.close()
    }
    this.sockets.set(nodeId, ws)

    const stopKeepalive = this.startKeepalive(nodeId, ws, log)

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString()) as TunnelResponse
        if (msg.type === 'http_response' && msg.id) {
          const handler = this.pending.get(msg.id)
          if (handler) {
            clearTimeout(handler.timer)
            this.pending.delete(msg.id)
            handler.resolve(msg)
          }
        }
      } catch (err) {
        // ignore malformed message
      }
    })

    ws.on('close', () => {
      stopKeepalive()
      if (this.sockets.get(nodeId) === ws) {
        this.sockets.delete(nodeId)
      }
    })

    ws.on('error', () => {
      stopKeepalive()
      if (this.sockets.get(nodeId) === ws) {
        this.sockets.delete(nodeId)
      }
    })
  }

  /**
   * Send one HTTP request down a node's tunnel and wait for its response.
   *
   * Takes the headers already decided by the caller rather than reading them off
   * the raw request: the ingress proxy owns forwarding policy for both paths to a
   * node, and this only has to carry them. Multi-value headers are flattened
   * because the wire format is one string per name.
   */
  public async forwardHttpRequest(
    nodeId: string,
    port: number,
    req: {
      method?: string
      url?: string
      headers: Record<string, string | string[] | undefined>
    },
    bodyBuf?: Buffer
  ): Promise<TunnelResponse> {
    const ws = this.sockets.get(nodeId)
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      throw new Error(`Node ${nodeId} reverse tunnel is not connected`)
    }

    const id = randomUUID()
    const headers: Record<string, string> = {}
    for (const [k, v] of Object.entries(req.headers)) {
      if (v) headers[k] = Array.isArray(v) ? v.join(', ') : v
    }

    const payload: TunnelRequest = {
      type: 'http_request',
      id,
      port,
      method: req.method || 'GET',
      path: req.url || '/',
      headers,
      body: bodyBuf && bodyBuf.length > 0 ? bodyBuf.toString('base64') : undefined,
    }

    return new Promise<TunnelResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Upstream request to node ${nodeId} timed out`))
      }, 30_000)

      this.pending.set(id, { nodeId, resolve, reject, timer })
      ws.send(JSON.stringify(payload), (err) => {
        if (err) {
          clearTimeout(timer)
          this.pending.delete(id)
          reject(err)
        }
      })
    })
  }
}

/**
 * Attaches the WebSocket reverse-tunnel server to Fastify's raw http server.
 */
export function setupTunnelServer(app: FastifyInstance, ctx: AppContext, registry: TunnelRegistry) {
  const wss = new WebSocketServer({ noServer: true })

  app.server.on('upgrade', async (req, socket, head) => {
    const url = new URL(req.url || '', `http://${req.headers.host}`)
    if (url.pathname !== '/agent/tunnel') {
      return // Not our path, ignore
    }

    const auth = req.headers.authorization || ''
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : url.searchParams.get('token')
    if (!token || !isAgentToken(token)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
      socket.destroy()
      return
    }

    // Authenticate agent token against nodes in DB
    try {
      const digest = hashToken(token)
      const rows = await ctx.db
        .select({ id: nodes.id, fleetId: nodes.fleetId })
        .from(nodes)
        .where(eq(nodes.agentTokenHash, digest))
        .limit(1)

      const node = rows[0]
      if (!node) {
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n')
        socket.destroy()
        return
      }

      wss.handleUpgrade(req, socket, head, (ws) => {
        app.log.info({ nodeId: node.id }, 'reverse tunnel connected')
        registry.register(node.id, ws, app.log)
      })
    } catch (err) {
      app.log.error({ err }, 'error authenticating tunnel upgrade')
      socket.write('HTTP/1.1 500 Internal Server Error\r\n\r\n')
      socket.destroy()
    }
  })
}

import { WebSocketServer, WebSocket } from 'ws'
import type { IncomingMessage } from 'node:http'
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
  resolve: (res: TunnelResponse) => void
  reject: (err: Error) => void
  timer: NodeJS.Timeout
}

export class TunnelRegistry {
  private sockets = new Map<string, WebSocket>()
  private pending = new Map<string, PendingRequest>()

  constructor(private ctx: AppContext) {}

  public has(nodeId: string): boolean {
    const ws = this.sockets.get(nodeId)
    return Boolean(ws && ws.readyState === WebSocket.OPEN)
  }

  public register(nodeId: string, ws: WebSocket) {
    // Close existing socket if any
    const existing = this.sockets.get(nodeId)
    if (existing && existing !== ws) {
      existing.close()
    }
    this.sockets.set(nodeId, ws)

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
      if (this.sockets.get(nodeId) === ws) {
        this.sockets.delete(nodeId)
      }
    })

    ws.on('error', () => {
      if (this.sockets.get(nodeId) === ws) {
        this.sockets.delete(nodeId)
      }
    })
  }

  public async forwardHttpRequest(
    nodeId: string,
    port: number,
    req: IncomingMessage,
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

      this.pending.set(id, { resolve, reject, timer })
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
        registry.register(node.id, ws)
      })
    } catch (err) {
      app.log.error({ err }, 'error authenticating tunnel upgrade')
      socket.write('HTTP/1.1 500 Internal Server Error\r\n\r\n')
      socket.destroy()
    }
  })
}

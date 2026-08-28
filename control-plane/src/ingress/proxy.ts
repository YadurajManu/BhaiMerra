import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http'
import { resolveRoute } from './routes.js'
import type { AppContext } from '../api/context.js'

export type IngressServer = { close: () => Promise<void>; port: number }

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailers',
  'transfer-encoding',
  'upgrade',
])

/**
 * The public edge (PRD 7.4).
 *
 * Resolves the Host header to whichever node currently runs the service and
 * streams the request there. Deliberately a separate listener from the API:
 * this port is exposed to the internet, and the control-plane API is not.
 *
 * Streaming rather than buffering matters — a file upload through a buffering
 * proxy is a memory limit waiting to be hit.
 */
export function startIngress(
  ctx: AppContext,
  opts: {
    port: number
    host?: string
    log?: { info: (o: unknown, m: string) => void; warn: (o: unknown, m: string) => void }
  }
): Promise<IngressServer> {
  const server = createServer((req, res) => {
    void handle(ctx, req, res, opts.log)
  })

  // A hung upstream must not hold a socket open indefinitely.
  server.requestTimeout = 120_000
  server.headersTimeout = 30_000

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(opts.port, opts.host ?? '0.0.0.0', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : opts.port
      resolve({
        port,
        close: () => new Promise<void>((done) => server.close(() => done())),
      })
    })
  })
}

async function handle(
  ctx: AppContext,
  req: IncomingMessage,
  res: ServerResponse,
  log?: { info: (o: unknown, m: string) => void; warn: (o: unknown, m: string) => void }
) {
  const host = req.headers.host
  if (!host) return fail(res, 400, 'no_host', 'Request has no Host header')

  let route
  try {
    route = await resolveRoute(ctx, host)
  } catch (err) {
    log?.warn({ err, host }, 'ingress route lookup failed')
    return fail(res, 503, 'lookup_failed', 'Could not resolve this hostname right now')
  }

  if (!route) {
    // Distinguishable from an upstream 404 on purpose: this means the fleet
    // has nothing serving that name, which is a different fix entirely.
    return fail(
      res,
      404,
      'no_route',
      `Nothing in this fleet is serving "${host}". Check \`fleet services\` for its hostname, ` +
        `and that a deployment is running.`
    )
  }

  const [upstreamHost, upstreamPort] = route.upstream.split(':')
  const targetPort = Number(upstreamPort)

  const headers = forwardedHeaders(req, host, route)

  // If the node has an active reverse tunnel, proxy through the tunnel!
  if (ctx.tunnels && ctx.tunnels.has(route.nodeId)) {
    const chunks: Buffer[] = []
    req.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)))
    req.on('end', async () => {
      try {
        const bodyBuf = Buffer.concat(chunks)
        const tunnelRes = await ctx.tunnels.forwardHttpRequest(
          route.nodeId,
          targetPort,
          { method: req.method, url: req.url, headers },
          bodyBuf
        )

        const outHeaders: Record<string, string> = { ...(tunnelRes.headers || {}) }
        for (const key of Object.keys(outHeaders)) {
          if (HOP_BY_HOP.has(key.toLowerCase())) delete outHeaders[key]
        }
        outHeaders['x-fleet-node'] = route.nodeName
        outHeaders['x-fleet-tunnel'] = 'active'

        const respBody = tunnelRes.body ? Buffer.from(tunnelRes.body, 'base64') : Buffer.alloc(0)
        outHeaders['content-length'] = String(respBody.length)

        res.writeHead(tunnelRes.status || 200, outHeaders)
        res.end(respBody)
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err)
        log?.warn({ err, host, nodeId: route.nodeId }, 'tunnel request failed')
        if (!res.headersSent) {
          fail(res, 502, 'tunnel_error', `Tunnel forwarding failed: ${message}`)
        }
      }
    })
    return
  }

  const upstream = httpRequest(
    {
      host: upstreamHost,
      port: targetPort,
      method: req.method,
      path: req.url,
      headers,
      timeout: 60_000,
    },
    (upstreamRes) => {
      const outHeaders = { ...upstreamRes.headers }
      for (const key of Object.keys(outHeaders)) {
        if (HOP_BY_HOP.has(key.toLowerCase())) delete outHeaders[key]
      }
      // Useful when debugging why a request landed where it did, and honest
      // about the fact that placement moves.
      outHeaders['x-fleet-node'] = route.nodeName
      res.writeHead(upstreamRes.statusCode ?? 502, outHeaders)
      upstreamRes.pipe(res)
    }
  )

  upstream.on('timeout', () => {
    upstream.destroy()
    if (!res.headersSent) fail(res, 504, 'upstream_timeout', `${route.nodeName} did not respond in time`)
  })

  upstream.on('error', (err) => {
    log?.warn({ err, host, upstream: route.upstream }, 'ingress upstream failed')
    if (!res.headersSent) {
      fail(
        res,
        502,
        'upstream_unreachable',
        `Could not reach ${route.serviceName} on ${route.nodeName}. ` +
          `If that node just went offline, the service is being rescheduled — retry shortly.`
      )
    }
  })

  req.pipe(upstream)
}

/**
 * The headers to send upstream, for either route to the node.
 *
 * Shared by the direct and the tunnel branch deliberately. These used to be
 * built inline on the direct path only, so a service reached through a tunnel
 * saw the control plane as its client: no real IP to rate-limit or audit by, and
 * no forwarded host to build absolute URLs from. Which headers go upstream is a
 * policy question and belongs in one place; how the bytes reach the node is the
 * transport's problem.
 */
export function forwardedHeaders(
  req: Pick<IncomingMessage, 'headers'> & { socket: Pick<IncomingMessage['socket'], 'remoteAddress'> },
  host: string,
  route: { nodeName: string; serviceName: string }
): Record<string, string | string[]> {
  const headers: Record<string, string | string[]> = {}
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue
    if (HOP_BY_HOP.has(key.toLowerCase())) continue
    headers[key] = value
  }

  // Append rather than replace: we are one hop in a chain that starts at
  // Cloudflare, and an app that wants the original client reads the first entry.
  const priorFor = req.headers['x-forwarded-for']
  const chain = Array.isArray(priorFor) ? priorFor.join(', ') : priorFor
  const clientIp = req.socket.remoteAddress ?? ''
  headers['x-forwarded-for'] = chain ? `${chain}, ${clientIp}` : clientIp

  headers['x-forwarded-host'] = host

  // Whatever is in front of us terminated TLS and said so. Overwriting that
  // with "http" is how an app ends up issuing http:// redirects for an https://
  // site, so an inbound value wins; "http" is only the direct-connection case.
  const proto = req.headers['x-forwarded-proto']
  headers['x-forwarded-proto'] = (Array.isArray(proto) ? proto[0] : proto) ?? 'http'

  headers['x-fleet-node'] = route.nodeName
  headers['x-fleet-service'] = route.serviceName
  return headers
}

function fail(res: ServerResponse, status: number, code: string, message: string) {
  const body = JSON.stringify({ error: { code, message } })
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
    'x-fleet-ingress': code,
  })
  res.end(body)
}

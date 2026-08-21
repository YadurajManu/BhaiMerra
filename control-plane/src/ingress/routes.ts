import { createHash } from 'node:crypto'
import { and, eq, inArray, isNotNull } from 'drizzle-orm'
import { deployments, fleets, nodes, services } from '../db/schema.js'
import type { AppContext } from '../api/context.js'

export type Route = {
  hostname: string
  serviceId: string
  serviceName: string
  fleetId: string
  nodeId: string
  nodeName: string
  /** Where the proxy actually connects, e.g. 192.168.1.40:31245 */
  upstream: string
  healthCheckPath: string
}

const ROUTE_KEY = (hostname: string) => `route:${hostname.toLowerCase()}`
const ROUTE_TTL_SEC = 30

/**
 * Ingress follows the service, not the node (PRD 7.4, FR-8).
 *
 * A hostname resolves to whichever node is *currently* running the service,
 * looked up fresh from the live deployment rather than from anything written
 * at deploy time. That is what makes a URL survive a failover: the routing
 * table is derived state, so there is nothing to forget to update.
 */
export async function resolveRoute(ctx: AppContext, hostname: string): Promise<Route | null> {
  const host = hostname.toLowerCase().split(':')[0]!

  // Cached briefly. The TTL is deliberately shorter than a failover takes, so
  // a stale entry cannot outlive the placement it describes; invalidateRoute
  // handles the common case immediately.
  const cached = await ctx.redis.get(ROUTE_KEY(host))
  if (cached) return cached === 'none' ? null : (JSON.parse(cached) as Route)

  const rows = await ctx.db
    .select({
      serviceId: services.id,
      serviceName: services.name,
      fleetId: services.fleetId,
      healthCheckPath: services.healthCheckPath,
      containerPort: services.containerPort,
      nodeId: nodes.id,
      nodeName: nodes.name,
      advertiseAddr: nodes.advertiseAddr,
      nodeStatus: nodes.status,
      hostPort: deployments.hostPort,
    })
    .from(services)
    .innerJoin(
      deployments,
      and(eq(deployments.serviceId, services.id), inArray(deployments.status, ['running', 'deploying']))
    )
    .innerJoin(nodes, eq(nodes.id, deployments.nodeId))
    .where(
      and(
        // Either hostname can address the service; both are unique.
        isNotNull(services.id),
        eq(services.hostname, host)
      )
    )
    .limit(1)

  let row = rows[0]
  if (!row) {
    const byDomain = await ctx.db
      .select({
        serviceId: services.id,
        serviceName: services.name,
        fleetId: services.fleetId,
        healthCheckPath: services.healthCheckPath,
        containerPort: services.containerPort,
        nodeId: nodes.id,
        nodeName: nodes.name,
        advertiseAddr: nodes.advertiseAddr,
        nodeStatus: nodes.status,
        hostPort: deployments.hostPort,
      })
      .from(services)
      .innerJoin(
        deployments,
        and(eq(deployments.serviceId, services.id), inArray(deployments.status, ['running', 'deploying']))
      )
      .innerJoin(nodes, eq(nodes.id, deployments.nodeId))
      .where(eq(services.domain, host))
      .limit(1)
    row = byDomain[0]
  }

  if (!row || !row.advertiseAddr || !row.hostPort) {
    // Cache the miss too, so an unknown host cannot turn into a database
    // query per request — that is a cheap denial of service otherwise.
    await ctx.redis.set(ROUTE_KEY(host), 'none', 'EX', 5)
    return null
  }

  const route: Route = {
    hostname: host,
    serviceId: row.serviceId,
    serviceName: row.serviceName,
    fleetId: row.fleetId,
    nodeId: row.nodeId,
    nodeName: row.nodeName,
    upstream: `${row.advertiseAddr}:${row.hostPort}`,
    healthCheckPath: row.healthCheckPath ?? '/',
  }

  await ctx.redis.set(ROUTE_KEY(host), JSON.stringify(route), 'EX', ROUTE_TTL_SEC)
  return route
}

/** Called whenever placement changes, so a URL points at the new node at once. */
export async function invalidateRoutesForService(ctx: AppContext, serviceId: string): Promise<void> {
  const [row] = await ctx.db
    .select({ hostname: services.hostname, domain: services.domain })
    .from(services)
    .where(eq(services.id, serviceId))
    .limit(1)
  if (!row) return

  const keys = [row.hostname, row.domain].filter(Boolean).map((h) => ROUTE_KEY(h as string))
  if (keys.length) await ctx.redis.del(...keys)
}

/**
 * The managed hostname for a service: <service>-<fleet>-<id>.<zone>.
 *
 * One DNS label, not three. A wildcard certificate covers exactly one level,
 * so `web.homelab-7efe4c.fleet.example.com` under `*.fleet.example.com` gets
 * no valid certificate and every deployed service fails TLS. Flattening to a
 * single label is what makes one wildcard record and one certificate serve
 * every service in the fleet.
 *
 * The fleet id suffix is not decoration either. Fleet names are unique per
 * org, not globally, and everyone's first fleet is called "homelab" — so
 * without it two unrelated users collide on their very first deploy. It is
 * derived from the fleet id, so it is stable and can be shown before anything
 * is deployed.
 */
export function managedHostname(
  serviceName: string,
  fleetName: string,
  fleetId: string,
  zone: string
): string {
  const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '')
  const suffix = createHash('sha256').update(fleetId).digest('hex').slice(0, 6)
  return `${slug(serviceName)}-${slug(fleetName)}-${suffix}.${zone}`
}

/**
 * Host ports are allocated from a fixed range, per node, so two services on
 * one machine cannot collide. Reusing a port that a stopping container still
 * holds is the classic failure here, so allocation skips anything currently
 * claimed on that node.
 */
export const PORT_RANGE = { min: 31000, max: 32767 } as const

export async function allocateHostPort(ctx: AppContext, nodeId: string): Promise<number> {
  const taken = await ctx.db
    .select({ port: deployments.hostPort })
    .from(deployments)
    .where(
      and(
        eq(deployments.nodeId, nodeId),
        inArray(deployments.status, ['deploying', 'running']),
        isNotNull(deployments.hostPort)
      )
    )

  const used = new Set(taken.map((t) => t.port))
  const span = PORT_RANGE.max - PORT_RANGE.min + 1

  // Start from a pseudo-random offset rather than the bottom of the range, so
  // a restarted service is unlikely to immediately reclaim a port the kernel
  // still has in TIME_WAIT.
  const start = Math.floor(Math.random() * span)
  for (let i = 0; i < span; i++) {
    const port = PORT_RANGE.min + ((start + i) % span)
    if (!used.has(port)) return port
  }
  throw new Error(`No free host port on node ${nodeId} in ${PORT_RANGE.min}-${PORT_RANGE.max}`)
}

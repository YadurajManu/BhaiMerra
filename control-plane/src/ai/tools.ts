import { and, desc, eq, inArray } from 'drizzle-orm'
import { deployments, nodes, placementEvents, services } from '../db/schema.js'
import type { AppContext } from '../api/context.js'

/**
 * What a diagnosis is allowed to look at.
 *
 * Every one of these is a query somebody ran by hand while working out why a
 * service was down: which deployments exist and how they ended, what the node
 * says it is running, what the container printed, why the scheduler moved
 * something. Finding the answer took twenty minutes a time and almost none of
 * it needed judgement — it needed somebody to ask six questions in the right
 * order and read the replies.
 *
 * Read-only, without exception. The failures worth diagnosing are the ones
 * where the system already acted on a bad inference; a diagnosis that can act
 * too would be the same mistake with a larger blast radius. It reports, and a
 * person decides.
 *
 * Scoped to one fleet at the boundary rather than by asking callers to filter,
 * so a tool cannot be talked into reading somebody else's.
 */

export type ToolResult = { ok: true; data: unknown } | { ok: false; error: string }

const ok = (data: unknown): ToolResult => ({ ok: true, data })
const fail = (error: string): ToolResult => ({ ok: false, error })

/** Resolve a service by name within the fleet, or say what names exist. */
async function findService(ctx: AppContext, fleetId: string, name: string) {
  const [svc] = await ctx.db
    .select()
    .from(services)
    .where(and(eq(services.fleetId, fleetId), eq(services.name, name)))
    .limit(1)
  return svc ?? null
}

export const TOOLS = {
  /**
   * Everything in the fleet and how it stands. The first call of almost any
   * diagnosis, because a name that does not exist is a different problem from
   * a service that is down.
   */
  async services(ctx: AppContext, fleetId: string): Promise<ToolResult> {
    const rows = await ctx.db
      .select({ name: services.name, project: services.project, id: services.id })
      .from(services)
      .where(eq(services.fleetId, fleetId))

    const live = await ctx.db
      .select({ serviceId: deployments.serviceId, status: deployments.status })
      .from(deployments)
      .innerJoin(services, eq(services.id, deployments.serviceId))
      .where(
        and(
          eq(services.fleetId, fleetId),
          inArray(deployments.status, ['deploying', 'running', 'pinned_unavailable'])
        )
      )
    const byService = new Map(live.map((d) => [d.serviceId, d.status]))

    return ok(
      rows.map((r) => ({ service: r.name, project: r.project, status: byService.get(r.id) ?? 'not running' }))
    )
  },

  /**
   * How a service's recent deployments ended.
   *
   * The single most useful view there is: a service that is down has a last
   * deployment, and its status and failure reason usually name the cause
   * outright.
   */
  async deployments(ctx: AppContext, fleetId: string, args: { service: string }): Promise<ToolResult> {
    const svc = await findService(ctx, fleetId, args.service)
    if (!svc) return fail(`no service named "${args.service}" in this fleet`)

    const rows = await ctx.db
      .select({
        status: deployments.status,
        startedAt: deployments.startedAt,
        finishedAt: deployments.finishedAt,
        failureReason: deployments.failureReason,
        nodeName: nodes.name,
        hostPort: deployments.hostPort,
      })
      .from(deployments)
      .leftJoin(nodes, eq(nodes.id, deployments.nodeId))
      .where(eq(deployments.serviceId, svc.id))
      .orderBy(desc(deployments.startedAt))
      .limit(8)

    return ok(
      rows.map((r) => ({
        status: r.status,
        started: r.startedAt.toISOString(),
        finished: r.finishedAt?.toISOString() ?? null,
        node: r.nodeName,
        hostPort: r.hostPort,
        // Trimmed: a buildx failure runs to a kilobyte and the first lines
        // carry the cause. The explainer exists for reading one in full.
        failureReason: r.failureReason?.slice(0, 400) ?? null,
      }))
    )
  },

  /** Node liveness — the answer to half of "why did this stop". */
  async nodes(ctx: AppContext, fleetId: string): Promise<ToolResult> {
    const rows = await ctx.db
      .select({
        name: nodes.name,
        status: nodes.status,
        arch: nodes.arch,
        agentVersion: nodes.agentVersion,
        lastHeartbeatAt: nodes.lastHeartbeatAt,
      })
      .from(nodes)
      .where(eq(nodes.fleetId, fleetId))

    return ok(
      rows.map((r) => ({
        node: r.name,
        status: r.status,
        arch: r.arch,
        agentVersion: r.agentVersion,
        lastHeartbeat: r.lastHeartbeatAt?.toISOString() ?? null,
        secondsSinceHeartbeat: r.lastHeartbeatAt
          ? Math.round((Date.now() - r.lastHeartbeatAt.getTime()) / 1000)
          : null,
      }))
    )
  },

  /**
   * What a node says it is actually running, from its last heartbeat.
   *
   * The control plane's view and the node's view disagreeing is the shape of
   * several real incidents: a container running and reported unhealthy for
   * ever, a deployment marked running whose container had been reaped.
   */
  async containers(ctx: AppContext, fleetId: string, args: { node: string }): Promise<ToolResult> {
    const [node] = await ctx.db
      .select({ id: nodes.id, name: nodes.name })
      .from(nodes)
      .where(and(eq(nodes.fleetId, fleetId), eq(nodes.name, args.node)))
      .limit(1)
    if (!node) return fail(`no node named "${args.node}" in this fleet`)

    const hb = await ctx.heartbeats.last(node.id).catch(() => null)
    if (!hb) return ok({ node: node.name, reported: null, note: 'this node has not reported recently' })

    return ok({
      node: node.name,
      at: new Date(hb.at).toISOString(),
      dockerAvailable: hb.runtime?.dockerAvailable ?? null,
      containers: (hb.containers ?? []).map((c) => ({
        name: c.name,
        state: c.state,
        health: c.health ?? null,
        deploymentId: c.deployment_id ?? null,
      })),
    })
  },

  /** The container's own output, as the node last reported it. */
  async logs(ctx: AppContext, fleetId: string, args: { service: string }): Promise<ToolResult> {
    const svc = await findService(ctx, fleetId, args.service)
    if (!svc) return fail(`no service named "${args.service}" in this fleet`)

    const [live] = await ctx.db
      .select({ nodeId: deployments.nodeId })
      .from(deployments)
      .where(
        and(eq(deployments.serviceId, svc.id), inArray(deployments.status, ['deploying', 'running']))
      )
      .orderBy(desc(deployments.startedAt))
      .limit(1)

    if (!live?.nodeId) return ok({ service: svc.name, lines: [], note: 'no live deployment to read a log from' })

    const hb = await ctx.heartbeats.last(live.nodeId).catch(() => null)
    const entry = hb?.logs?.find((l) => l.service === svc.name)
    return ok({
      service: svc.name,
      // The tail, not the log: the last lines are where a crash says why.
      lines: entry?.text.split(/\r?\n/).filter(Boolean).slice(-40) ?? [],
      note: entry ? null : 'the agent has not reported a log tail for this service',
    })
  },

  /** Why the scheduler moved something, and where it went. */
  async placements(ctx: AppContext, fleetId: string, args: { service: string }): Promise<ToolResult> {
    const svc = await findService(ctx, fleetId, args.service)
    if (!svc) return fail(`no service named "${args.service}" in this fleet`)

    const rows = await ctx.db
      .select({
        reason: placementEvents.reason,
        detail: placementEvents.detail,
        createdAt: placementEvents.createdAt,
        toNodeId: placementEvents.toNodeId,
      })
      .from(placementEvents)
      .where(eq(placementEvents.serviceId, svc.id))
      .orderBy(desc(placementEvents.createdAt))
      .limit(6)

    return ok(rows.map((r) => ({ reason: r.reason, at: r.createdAt.toISOString(), detail: r.detail })))
  },

  /**
   * Whether the service answers on its public address.
   *
   * The one tool that leaves the database, and the one that settles "is it
   * actually broken" — a service reported running that answers 502 and a
   * service reported running that answers 200 are different problems.
   */
  async probe(ctx: AppContext, fleetId: string, args: { service: string }): Promise<ToolResult> {
    const svc = await findService(ctx, fleetId, args.service)
    if (!svc) return fail(`no service named "${args.service}" in this fleet`)

    const host = svc.domain ?? svc.hostname
    if (!host) return ok({ service: svc.name, note: 'this service has no public hostname' })

    const url = `https://${host}`
    try {
      const res = await fetch(url, {
        method: 'GET',
        redirect: 'manual',
        signal: AbortSignal.timeout(10_000),
      })
      const body = await res.text().catch(() => '')
      return ok({
        service: svc.name,
        url,
        status: res.status,
        bytes: body.length,
        // A snippet, because "200 with nginx's welcome page" and "200 with the
        // site" are the same status and different outcomes.
        firstBytes: body.slice(0, 120).replace(/\s+/g, ' ').trim(),
      })
    } catch (err) {
      return ok({ service: svc.name, url, status: null, error: err instanceof Error ? err.message : 'unreachable' })
    }
  },
} as const

export type ToolName = keyof typeof TOOLS

/** Call a tool by name, with whatever arguments a model produced. */
export async function callTool(
  ctx: AppContext,
  fleetId: string,
  name: string,
  args: Record<string, unknown>
): Promise<ToolResult> {
  const tool = (TOOLS as Record<string, unknown>)[name]
  if (typeof tool !== 'function') {
    return fail(`no tool named "${name}". Available: ${Object.keys(TOOLS).join(', ')}`)
  }
  try {
    return await (tool as (c: AppContext, f: string, a: Record<string, unknown>) => Promise<ToolResult>)(
      ctx,
      fleetId,
      args ?? {}
    )
  } catch (err) {
    // A tool failing is information, not the end of the diagnosis: "the node
    // did not answer" is often the finding itself.
    return fail(err instanceof Error ? err.message : 'the tool failed')
  }
}

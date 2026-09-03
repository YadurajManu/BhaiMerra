import { and, eq, desc } from 'drizzle-orm'
import { z } from 'zod'
import type { FastifyInstance } from 'fastify'
import { nodes, fleets, pairingTokens, orgMembers, auditLog, alertRules } from '../db/schema.js'
import { newPairingToken, hashToken } from '../lib/tokens.js'
import { recordAudit } from '../lib/audit.js'
import { ApiError } from './errors.js'
import { requireUser, requireFleetPermission, invalidateAgentAuth } from './guards.js'
import { dispatchEvent } from '../alerting/dispatch.js'
import { samplesFor, grainFor, RETAIN_MS } from '../heartbeat/samples.js'
import { rescheduleFromNode } from '../scheduler/reschedule.js'
import { publicApiOrigin } from './install.routes.js'
import { FLEET_EVENTS } from '../lib/events.js'

const PAIRING_TTL_MIN = 10

/** Show the destination without handing back a reusable credential. */
function redactTarget(config: Record<string, unknown>): string {
  if (typeof config.to === 'string') return config.to
  const url = typeof config.url === 'string' ? config.url : ''
  if (!url) return 'unknown'
  try {
    const parsed = new URL(url)
    return `${parsed.protocol}//${parsed.host}/…`
  } catch {
    return 'invalid url'
  }
}

export async function fleetRoutes(app: FastifyInstance) {
  const { db, redis, heartbeats, config } = app.ctx

  /** Every fleet the caller can see, across all their orgs. */
  app.get('/fleets', { preHandler: requireUser }, async (req) => {
    const rows = await db
      .select({
        id: fleets.id,
        name: fleets.name,
        orgId: fleets.orgId,
        role: orgMembers.role,
        defaultReclaimPolicy: fleets.defaultReclaimPolicy,
        heartbeatIntervalSec: fleets.heartbeatIntervalSec,
        heartbeatMissThreshold: fleets.heartbeatMissThreshold,
      })
      .from(fleets)
      .innerJoin(orgMembers, eq(orgMembers.orgId, fleets.orgId))
      .where(eq(orgMembers.userId, req.userId!))
    return { fleets: rows }
  })

  app.get(
    '/fleets/:fleetId',
    { preHandler: requireFleetPermission('fleet.read') },
    async (req) => {
      const { fleetId } = req.params as { fleetId: string }
      const rows = await db.select().from(fleets).where(eq(fleets.id, fleetId)).limit(1)
      if (!rows[0]) throw ApiError.notFound('Fleet')
      return { fleet: rows[0], role: req.orgRole }
    }
  )

  /**
   * Node list, joined against live heartbeat state. The stored status column
   * is the durable record; Redis is what happened in the last few seconds.
   * Showing both means a stale status column is visible rather than hidden.
   */
  app.get(
    '/fleets/:fleetId/nodes',
    { preHandler: requireFleetPermission('node.read') },
    async (req) => {
      const { fleetId } = req.params as { fleetId: string }

      const [fleet] = await db.select().from(fleets).where(eq(fleets.id, fleetId)).limit(1)
      if (!fleet) throw ApiError.notFound('Fleet')

      const rows = await db.select().from(nodes).where(eq(nodes.fleetId, fleetId))
      const live = new Set(
        await heartbeats.liveNodes(fleetId, {
          intervalSec: fleet.heartbeatIntervalSec,
          threshold: fleet.heartbeatMissThreshold,
        })
      )

      const withTelemetry = await Promise.all(
        rows.map(async (n) => {
          const hb = await heartbeats.last(n.id)
          const { agentTokenHash: _omit, ...safe } = n
          return {
            ...safe,
            live: live.has(n.id),
            /**
             * Whether the node currently holds an open reverse tunnel.
             *
             * The dashboard was drawing this from the heartbeat's
             * `mesh_connected`, which the agent declares and never assigns —
             * so every node rendered "No Tunnel" while its tunnel was up and
             * carrying ingress traffic. The two are different subsystems: the
             * mesh is WireGuard between nodes, the tunnel is the socket this
             * process is holding right now, and only the registry knows about
             * the latter.
             */
            tunnelConnected: app.ctx.tunnels.has(n.id),
            telemetry: hb
              ? {
                  cpuPct: hb.cpuPct,
                  ramUsedMb: hb.ramUsedMb,
                  diskUsedMb: hb.diskUsedMb,
                  containers: hb.containers,
                  meshConnected: hb.meshConnected,
                  runtime: hb.runtime ?? { dockerAvailable: false, registryStatus: 'not_tested' },
                  ageMs: Date.now() - hb.at,
                }
              : null,
          }
        })
      )

      return { nodes: withTelemetry }
    }
  )

  /** FR-1: issue a short-lived, single-use pairing token. */
  app.post(
    '/fleets/:fleetId/nodes/pair-token',
    { preHandler: requireFleetPermission('node.pair') },
    async (req, reply) => {
      const { fleetId } = req.params as { fleetId: string }
      const token = newPairingToken()
      const expiresAt = new Date(Date.now() + PAIRING_TTL_MIN * 60_000)

      await db.transaction(async (tx) => {
        await tx.insert(pairingTokens).values({
          fleetId,
          tokenHash: hashToken(token),
          issuedByUserId: req.userId!,
          expiresAt,
        })
        await recordAudit(tx, {
          orgId: req.orgId!,
          actorUserId: req.userId,
          action: 'node.pair_token_issued',
          targetType: 'fleet',
          targetId: fleetId,
          metadata: { expiresAt: expiresAt.toISOString() },
        })
      })

      return reply.code(201).send({
        // Returned once. Only the hash is stored.
        token,
        expires_at: expiresAt.toISOString(),
        // Built from the address the caller actually reached us on. Hardcoding
        // a domain here handed self-hosters a command pointing at a host that
        // does not resolve for them.
        install_command: `curl -fsSL ${publicApiOrigin(req, config)}/install | sh -s -- --token ${token}`,
      })
    }
  )

  /**
   * Telemetry history for one node.
   *
   * `since` is a window in minutes rather than a start timestamp, because every
   * caller wants "the last hour" and none of them want to compute a boundary
   * that is already stale by the time the request lands. The grain is chosen
   * from the window and reported back, so a chart knows how far apart its
   * points are without guessing from their spacing.
   */
  app.get(
    '/fleets/:fleetId/nodes/:nodeId/samples',
    { preHandler: requireFleetPermission('node.read') },
    async (req) => {
      const { nodeId } = req.params as { nodeId: string }
      const q = z
        .object({ since: z.coerce.number().int().min(1).max(43_200).default(60) })
        .safeParse(req.query ?? {})
      // A bad window is not worth a 422 when the obvious reading is an hour.
      const minutes = q.success ? q.data.since : 60
      const sinceMs = minutes * 60_000

      return {
        grain: grainFor(sinceMs),
        sinceMinutes: minutes,
        retention: RETAIN_MS,
        samples: await samplesFor(app.ctx, nodeId, sinceMs),
      }
    }
  )

  /** Cordon: stop scheduling here, leave what is running alone (PRD 7.1). */
  app.post(
    '/fleets/:fleetId/nodes/:nodeId/cordon',
    { preHandler: requireFleetPermission('node.cordon') },
    async (req) => {
      const { fleetId, nodeId } = req.params as { fleetId: string; nodeId: string }
      const body = z.object({ cordoned: z.boolean().default(true) }).parse(req.body ?? {})

      const updated = await db.transaction(async (tx) => {
        const [node] = await tx
          .select()
          .from(nodes)
          .where(and(eq(nodes.id, nodeId), eq(nodes.fleetId, fleetId)))
          .limit(1)
        if (!node) throw ApiError.notFound('Node')

        // Uncordoning returns the node to offline; the next heartbeat, or the
        // sweeper, decides whether it is actually up.
        const next = body.cordoned ? 'cordoned' : 'offline'
        const [row] = await tx
          .update(nodes)
          .set({ status: next })
          .where(eq(nodes.id, nodeId))
          .returning()

        await recordAudit(tx, {
          orgId: req.orgId!,
          actorUserId: req.userId,
          action: body.cordoned ? 'node.cordoned' : 'node.uncordoned',
          targetType: 'node',
          targetId: nodeId,
        })
        return row!
      })

      const { agentTokenHash: _omit, ...safe } = updated
      return { node: safe }
    }
  )

  /**
   * Remove a node from the fleet.
   *
   * Order matters here. Workloads are evicted *before* the row is deleted,
   * because deployments.nodeId is ON DELETE SET NULL: delete first and the
   * eviction query finds nothing, leaving deployments marked 'running' with no
   * node to run on — services that look healthy in the dashboard and are
   * reachable from nowhere.
   */
  app.delete(
    '/fleets/:fleetId/nodes/:nodeId',
    { preHandler: requireFleetPermission('node.remove') },
    async (req) => {
      const { fleetId, nodeId } = req.params as { fleetId: string; nodeId: string }

      const [existing] = await db
        .select()
        .from(nodes)
        .where(and(eq(nodes.id, nodeId), eq(nodes.fleetId, fleetId)))
        .limit(1)
      if (!existing) throw ApiError.notFound('Node')

      // Take it out of the schedulable set first, or the reschedule below can
      // choose the very node being removed — it is still 'online' at this point.
      await db.update(nodes).set({ status: 'draining' }).where(eq(nodes.id, nodeId))

      // Same failover path a down node takes: flexible and preferred services
      // move, pinned services are held and raise their own alert rather than
      // being separated from their volume.
      const evicted = await rescheduleFromNode(app.ctx, fleetId, nodeId, {
        onEvent: async (e) => { await dispatchEvent(app.ctx, e, { log: req.log, email: app.ctx.email }) },
      })

      const removed = await db.transaction(async (tx) => {
        const [node] = await tx
          .select()
          .from(nodes)
          .where(and(eq(nodes.id, nodeId), eq(nodes.fleetId, fleetId)))
          .limit(1)
        if (!node) throw ApiError.notFound('Node')

        await tx.delete(nodes).where(eq(nodes.id, nodeId))
        await recordAudit(tx, {
          orgId: req.orgId!,
          actorUserId: req.userId,
          action: 'node.removed',
          targetType: 'node',
          targetId: nodeId,
          metadata: { name: node.name, evicted: evicted.length },
        })
        return node
      })

      // Revoke immediately — a removed node's token must stop working now,
      // not when its 60s auth cache happens to expire.
      await invalidateAgentAuth(redis, removed.agentTokenHash)
      await heartbeats.forget(fleetId, nodeId)

      // Credentials alone are not enough: an already-open reverse tunnel was
      // authenticated at upgrade time and is never re-checked, so ingress could
      // still reach this node. ADR 0001 calls this out as a consequence of
      // choosing the tunnel — revoking a node must also close it.
      const tunnelClosed = app.ctx.tunnels?.close(nodeId) ?? false
      if (tunnelClosed) req.log.info({ nodeId }, 'reverse tunnel closed on node removal')

      return {
        removed: { id: nodeId, name: removed.name },
        evicted,
        tunnelClosed,
      }
    }
  )

  /** FR-15 read side. */
  app.get(
    '/fleets/:fleetId/audit',
    { preHandler: requireFleetPermission('audit.read') },
    async (req) => {
      const q = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }).parse(req.query ?? {})
      const rows = await db
        .select()
        .from(auditLog)
        .where(eq(auditLog.orgId, req.orgId!))
        .orderBy(desc(auditLog.createdAt))
        .limit(q.limit)
      return { entries: rows }
    }
  )

  /* ── alert rules (FR-12) ─────────────────────────────────────── */

  const alertRuleBody = z.object({
    channelType: z.enum(['webhook', 'email', 'discord', 'slack', 'push']),
    // An empty list means every event — the sane default for someone who
    // just wants to know when something happens.
    eventTypes: z.array(z.enum(FLEET_EVENTS)).default([]),
    url: z.string().url().optional(),
    to: z.string().email().optional(),
    secret: z.string().min(16).max(256).optional(),
    enabled: z.boolean().default(true),
  })

  app.post(
    '/fleets/:fleetId/alert-rules',
    { preHandler: requireFleetPermission('alert.write') },
    async (req, reply) => {
      const parsed = alertRuleBody.safeParse(req.body)
      if (!parsed.success) {
        throw ApiError.unprocessable('invalid_alert_rule', 'Check the submitted fields', parsed.error.issues)
      }
      const { fleetId } = req.params as { fleetId: string }
      const { channelType, eventTypes, enabled, ...channel } = parsed.data

      if (channelType === 'email' && !channel.to) {
        throw ApiError.unprocessable('missing_recipient', 'An email rule needs "to"')
      }
      if (channelType !== 'email' && !channel.url) {
        throw ApiError.unprocessable('missing_url', `A ${channelType} rule needs "url"`)
      }

      const created = await db.transaction(async (tx) => {
        const [row] = await tx
          .insert(alertRules)
          .values({ fleetId, channelType, eventTypes, enabled, channelConfig: channel })
          .returning()
        await recordAudit(tx, {
          orgId: req.orgId!,
          actorUserId: req.userId,
          action: 'alert.rule_created',
          targetType: 'fleet',
          targetId: fleetId,
          metadata: { channelType, eventTypes },
        })
        return row!
      })

      // The secret and URL are credentials; echoing them back into a log or a
      // screenshot is how they leak.
      const { channelConfig: _hidden, ...safe } = created
      return reply.code(201).send({ rule: { ...safe, configured: Object.keys(channel) } })
    }
  )

  app.get(
    '/fleets/:fleetId/alert-rules',
    { preHandler: requireFleetPermission('alert.write') },
    async (req) => {
      const { fleetId } = req.params as { fleetId: string }
      const rows = await db.select().from(alertRules).where(eq(alertRules.fleetId, fleetId))
      return {
        rules: rows.map(({ channelConfig, ...r }) => ({
          ...r,
          // Enough to identify the destination, not enough to reuse it.
          target: redactTarget(channelConfig),
        })),
      }
    }
  )

  app.delete(
    '/fleets/:fleetId/alert-rules/:ruleId',
    { preHandler: requireFleetPermission('alert.write') },
    async (req) => {
      const { fleetId, ruleId } = req.params as { fleetId: string; ruleId: string }
      const deleted = await db
        .delete(alertRules)
        .where(and(eq(alertRules.id, ruleId), eq(alertRules.fleetId, fleetId)))
        .returning({ id: alertRules.id })
      if (!deleted.length) throw ApiError.notFound('Alert rule')
      return { removed: deleted[0]!.id }
    }
  )

  /** Send a test event so a rule can be verified before an incident. */
  app.post(
    '/fleets/:fleetId/alert-rules/test',
    { preHandler: requireFleetPermission('alert.write') },
    async (req) => {
      const { fleetId } = req.params as { fleetId: string }
      const results = await dispatchEvent(
        app.ctx,
        {
          type: 'node.down',
          fleetId,
          at: new Date().toISOString(),
          subject: 'test-node',
          detail: { missedThreshold: 3, intervalSec: 5, silentForMs: 15000, test: true },
        },
        { log: app.log, email: app.ctx.email }
      )
      return { delivered: results.filter((r) => r.ok).length, results }
    }
  )

  app.get('/healthz', async () => {
    const [dbOk, redisOk] = await Promise.allSettled([
      db.select({ id: fleets.id }).from(fleets).limit(1),
      redis.ping(),
    ])
    const healthy = dbOk.status === 'fulfilled' && redisOk.status === 'fulfilled'
    return {
      status: healthy ? 'ok' : 'degraded',
      postgres: dbOk.status === 'fulfilled',
      redis: redisOk.status === 'fulfilled',
      heartbeat_interval_sec: config.HEARTBEAT_INTERVAL_SEC,
      heartbeat_miss_threshold: config.HEARTBEAT_MISS_THRESHOLD,
      version: config.CONTROL_PLANE_VERSION,
    }
  })
}

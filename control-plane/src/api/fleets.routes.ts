import { and, eq, desc } from 'drizzle-orm'
import { z } from 'zod'
import type { FastifyInstance } from 'fastify'
import { nodes, fleets, pairingTokens, orgMembers, auditLog } from '../db/schema.js'
import { newPairingToken, hashToken } from '../lib/tokens.js'
import { recordAudit } from '../lib/audit.js'
import { ApiError } from './errors.js'
import { requireUser, requireFleetPermission, invalidateAgentAuth } from './guards.js'

const PAIRING_TTL_MIN = 10

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
            telemetry: hb
              ? {
                  cpuPct: hb.cpuPct,
                  ramUsedMb: hb.ramUsedMb,
                  diskUsedMb: hb.diskUsedMb,
                  containers: hb.containers,
                  meshConnected: hb.meshConnected,
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
        install_command: `curl -fsSL fleet-os.dev/install | sh -s -- --token ${token}`,
      })
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

  app.delete(
    '/fleets/:fleetId/nodes/:nodeId',
    { preHandler: requireFleetPermission('node.remove') },
    async (req) => {
      const { fleetId, nodeId } = req.params as { fleetId: string; nodeId: string }

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
          metadata: { name: node.name },
        })
        return node
      })

      // Revoke immediately — a removed node's token must stop working now,
      // not when its 60s auth cache happens to expire.
      await invalidateAgentAuth(redis, removed.agentTokenHash)
      await heartbeats.forget(fleetId, nodeId)

      return { removed: { id: nodeId, name: removed.name } }
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
    }
  })
}

import { and, eq, isNull, gt, inArray, ne } from 'drizzle-orm'
import { z } from 'zod'
import type { FastifyInstance } from 'fastify'
import { nodes, fleets, pairingTokens, deployments, services } from '../db/schema.js'
import { hashToken, newAgentToken, isPairingToken } from '../lib/tokens.js'
import { recordAudit } from '../lib/audit.js'
import { ApiError } from './errors.js'
import { requireAgent } from './guards.js'
import { reclaimToNode } from '../scheduler/reclaim.js'
import { detectDrift } from '../heartbeat/drift.js'
import { dispatchEvent } from '../alerting/dispatch.js'

/** The capability report an agent sends at registration (tech doc §7). */
const capability = z.object({
  arch: z.enum(['arm64', 'armv7', 'amd64']),
  os: z.string().max(32).default('linux'),
  cpu_cores: z.number().int().min(1).max(1024),
  ram_mb: z.number().int().min(64),
  disk_mb: z.number().int().min(0),
  gpu: z.boolean().default(false),
  connectivity: z.enum(['direct', 'nat', 'unknown']).default('unknown'),
  hostname: z.string().min(1).max(64).optional(),
  agent_version: z.string().max(32).optional(),
  /** Where ingress can reach this node. Becomes the mesh address in Phase 4b. */
  advertise_addr: z.string().max(255).optional(),
})

const heartbeat = z.object({
  cpu_pct: z.number().min(0).max(100),
  ram_used_mb: z.number().int().min(0),
  disk_used_mb: z.number().int().min(0),
  mesh_connected: z.boolean().default(false),
  agent_version: z.string().max(32).optional(),
  advertise_addr: z.string().max(255).optional(),
  containers: z
    .array(
      z.object({
        name: z.string().max(128),
        state: z.string().max(32),
        health: z.string().max(32).optional(),
      })
    )
    .max(200)
    .default([]),
  runtime: z.object({
    docker_available: z.boolean(),
    docker_version: z.string().max(128).optional(),
    docker_api_version: z.string().max(64).optional(),
    docker_error: z.string().max(1000).optional(),
    registry_status: z.enum(['ok', 'failed', 'not_tested']).optional(),
    registry_error: z.string().max(1000).optional(),
    last_reconcile_error: z.string().max(2000).optional(),
  }).default({ docker_available: false, registry_status: 'not_tested' }),
  logs: z.array(z.object({ service: z.string().max(128), text: z.string().max(32_000) })).max(50).default([]),
})

/** Slug a hostname into something usable and stable as a node name. */
function slugify(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'node'
}

export async function agentRoutes(app: FastifyInstance) {
  const { db, redis, heartbeats } = app.ctx

  /**
   * Pairing. The token is single-use and short-lived; consuming it is done
   * inside the same transaction that creates the node, so two agents racing
   * the same token cannot both register.
   */
  app.post('/agent/register', async (req, reply) => {
    const header = req.headers.authorization
    const token = header?.startsWith('Bearer ') ? header.slice(7).trim() : undefined
    if (!token || !isPairingToken(token)) {
      throw ApiError.unauthorized('A pairing token is required to register')
    }

    const parsed = capability.safeParse(req.body)
    if (!parsed.success) {
      throw ApiError.unprocessable('invalid_capability', 'Capability report rejected', parsed.error.issues)
    }
    const cap = parsed.data
    const agentToken = newAgentToken()

    const result = await db.transaction(async (tx) => {
      const rows = await tx
        .select({ id: pairingTokens.id, fleetId: pairingTokens.fleetId, orgId: fleets.orgId })
        .from(pairingTokens)
        .innerJoin(fleets, eq(fleets.id, pairingTokens.fleetId))
        .where(
          and(
            eq(pairingTokens.tokenHash, hashToken(token)),
            isNull(pairingTokens.consumedAt),
            gt(pairingTokens.expiresAt, new Date())
          )
        )
        .for('update')
        .limit(1)

      const pairing = rows[0]
      if (!pairing) {
        throw ApiError.unauthorized('Pairing token is invalid, expired or already used')
      }

      // Names must be unique per fleet; fall back to a suffix rather than
      // failing an install script the user cannot easily edit.
      const base = slugify(cap.hostname ?? `${cap.arch}-node`)
      let name = base
      for (let i = 2; i < 100; i++) {
        const clash = await tx
          .select({ id: nodes.id })
          .from(nodes)
          .where(and(eq(nodes.fleetId, pairing.fleetId), eq(nodes.name, name)))
          .limit(1)
        if (!clash.length) break
        name = `${base}-${i}`
      }

      const [node] = await tx
        .insert(nodes)
        .values({
          fleetId: pairing.fleetId,
          name,
          arch: cap.arch,
          os: cap.os,
          cpuCores: cap.cpu_cores,
          ramMb: cap.ram_mb,
          diskMb: cap.disk_mb,
          hasGpu: cap.gpu,
          connectivity: cap.connectivity,
          agentTokenHash: hashToken(agentToken),
          agentVersion: cap.agent_version,
          advertiseAddr: cap.advertise_addr ?? null,
          status: 'online',
          lastHeartbeatAt: new Date(),
        })
        .returning()

      await tx
        .update(pairingTokens)
        .set({ consumedAt: new Date(), consumedByNodeId: node!.id })
        .where(eq(pairingTokens.id, pairing.id))

      await recordAudit(tx, {
        orgId: pairing.orgId,
        actorKind: 'agent',
        action: 'node.registered',
        targetType: 'node',
        targetId: node!.id,
        metadata: { name, arch: cap.arch, ramMb: cap.ram_mb, cpuCores: cap.cpu_cores },
      })

      return node!
    })

    // Enter the sweep window now, so an agent that registers and then never
    // beats is detected as down rather than looking healthy indefinitely.
    await heartbeats.markRegistered(result.fleetId, result.id)

    req.log.info({ nodeId: result.id, name: result.name, arch: result.arch }, 'node registered')

    return reply.code(201).send({
      node_id: result.id,
      fleet_id: result.fleetId,
      name: result.name,
      // Shown exactly once. The control plane keeps only its hash.
      agent_token: agentToken,
      heartbeat_interval_sec: app.ctx.config.HEARTBEAT_INTERVAL_SEC,
    })
  })

  /**
   * Heartbeat. Hot path — one write per node per interval — so it touches
   * Redis only. Postgres is updated by the sweeper on state transitions,
   * not on every beat.
   */
  app.post('/agent/heartbeat', { preHandler: requireAgent }, async (req) => {
    const parsed = heartbeat.safeParse(req.body)
    if (!parsed.success) {
      throw ApiError.unprocessable('invalid_heartbeat', 'Heartbeat rejected', parsed.error.issues)
    }
    const hb = parsed.data
    const nodeId = req.agentNodeId!
    const fleetId = req.agentFleetId!

    await heartbeats.record({
      nodeId,
      fleetId,
      cpuPct: hb.cpu_pct,
      ramUsedMb: hb.ram_used_mb,
      diskUsedMb: hb.disk_used_mb,
      containers: hb.containers,
      meshConnected: hb.mesh_connected,
      agentVersion: hb.agent_version,
      runtime: {
        dockerAvailable: hb.runtime.docker_available,
        dockerVersion: hb.runtime.docker_version,
        dockerApiVersion: hb.runtime.docker_api_version,
        dockerError: hb.runtime.docker_error,
        registryStatus: hb.runtime.registry_status,
        registryError: hb.runtime.registry_error,
        lastReconcileError: hb.runtime.last_reconcile_error,
      },
      logs: hb.logs,
    })

    // Promote deployments the agent reports as actually running. The control
    // plane schedules; only the node can say whether the container came up,
    // so this is the one place 'deploying' becomes 'running'.
    const up = new Set(
      hb.containers.filter((c) => c.state === 'running').map((c) => c.name)
    )
    if (up.size) {
      const pending = await db
        .select({ id: deployments.id, name: services.name })
        .from(deployments)
        .innerJoin(services, eq(services.id, deployments.serviceId))
        .where(and(eq(deployments.nodeId, nodeId), eq(deployments.status, 'deploying')))

      const nowRunning = pending.filter((p) => up.has(p.name))
      if (nowRunning.length) {
        await db
          .update(deployments)
          .set({ status: 'running', finishedAt: new Date() })
          .where(inArray(deployments.id, nowRunning.map((p) => p.id)))
        req.log.info({ nodeId, services: nowRunning.map((p) => p.name) }, 'deployments now running')
      }
    }

    if (hb.advertise_addr) {
      // A node's address can change (DHCP, a new network). Keeping the stale
      // one would send ingress traffic into a black hole.
      await db
        .update(nodes)
        .set({ advertiseAddr: hb.advertise_addr })
        .where(and(eq(nodes.id, nodeId), ne(nodes.advertiseAddr, hb.advertise_addr)))
    }

    // Drift: what the node says is not running, that we believe is. Debounced
    // through Redis so a container restarting between two beats does not fire
    // an alert on every heartbeat.
    if (hb.containers.length) {
      const drifted = await detectDrift(app.ctx, nodeId, fleetId, hb.containers, {
        onEvent: async (e) => {
          const key = `drift:${nodeId}:${e.subject}`
          if (await redis.set(key, '1', 'EX', 300, 'NX')) {
            await dispatchEvent(app.ctx, e, { log: req.log })
            req.log.warn({ event: e }, 'drift detected')
          }
        },
      })
      if (drifted.length) {
        await db
          .update(deployments)
          .set({ failureReason: 'drift' })
          .where(inArray(deployments.id, drifted.map((d) => d.deploymentId)))
      }
    }

    // A node that was marked down and is beating again comes back here rather
    // than waiting for the sweeper, so recovery is as fast as failure.
    const wasDown = await redis.getdel(`node:${nodeId}:down`)
    if (wasDown) {
      await db
        .update(nodes)
        .set({ status: 'online', lastHeartbeatAt: new Date() })
        .where(and(eq(nodes.id, nodeId), eq(nodes.status, 'offline')))
      req.log.info({ nodeId }, 'node recovered')

      // FR-9: apply the reclaim policy now that it is back. Failures here
      // must not fail the heartbeat — the node is alive either way.
      try {
        const outcomes = await reclaimToNode(app.ctx, fleetId, nodeId, {
          onEvent: async (e) => { await dispatchEvent(app.ctx, e, { log: req.log }) },
        })
        if (outcomes.length) req.log.info({ nodeId, outcomes }, 'reclaim policy applied')
      } catch (err) {
        req.log.error({ err, nodeId }, 'reclaim failed after node returned')
      }
    }

    return { ok: true, interval_sec: app.ctx.config.HEARTBEAT_INTERVAL_SEC }
  })

  /**
   * Desired state. The agent reconciles toward this; it never decides
   * placement itself (tech doc §7).
   */
  app.get('/agent/desired-state', { preHandler: requireAgent }, async (req) => {
    const nodeId = req.agentNodeId!

    const rows = await db
      .select({
        service: services.name,
        image: services.image,
        imageTags: deployments.imageTags,
        deploymentId: deployments.id,
        hostPort: deployments.hostPort,
        containerPort: services.containerPort,
        healthCheckPath: services.healthCheckPath,
        volumeName: services.volumeName,
        replicas: services.replicas,
      })
      .from(deployments)
      .innerJoin(services, eq(services.id, deployments.serviceId))
      // Both states: 'deploying' is what the agent is being asked to converge
      // *toward*, and 'running' is what it should keep running. Returning only
      // 'running' meant a fresh deployment was never handed to anyone, and
      // nothing ever promoted it.
      .where(
        and(
          eq(deployments.nodeId, nodeId),
          inArray(deployments.status, ['deploying', 'running'])
        )
      )

    return {
      node_id: nodeId,
      generated_at: new Date().toISOString(),
      services: rows.map((r) => ({
        name: r.service,
        deployment_id: r.deploymentId,
        image: r.image ?? r.imageTags[0] ?? null,
        health_check_path: r.healthCheckPath,
        host_port: r.hostPort,
        container_port: r.containerPort,
        volume: r.volumeName,
        replicas: r.replicas,
      })),
    }
  })
}

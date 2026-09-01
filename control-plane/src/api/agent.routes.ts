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
import { buildEnv } from '../secrets/store.js'
import { invalidateRoutesForService } from '../ingress/routes.js'

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
        /** Absent from agents older than the health-gated rollout. */
        deployment_id: z.string().max(64).optional(),
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

/**
 * The credential a node needs to pull from the fleet registry.
 *
 * Docker's own X-Registry-Auth shape, which is what the agent base64-encodes
 * onto the pull. Returns null when the registry needs no credentials, so an
 * unauthenticated local registry keeps working with nothing configured.
 */
function registryAuth(config: {
  REGISTRY_URL?: string
  REGISTRY_CREDENTIALS?: string
}): string | null {
  const { REGISTRY_URL, REGISTRY_CREDENTIALS } = config
  if (!REGISTRY_URL || !REGISTRY_CREDENTIALS) return null

  const separator = REGISTRY_CREDENTIALS.indexOf(':')
  if (separator < 1) return null

  return JSON.stringify({
    username: REGISTRY_CREDENTIALS.slice(0, separator),
    password: REGISTRY_CREDENTIALS.slice(separator + 1),
    serveraddress: REGISTRY_URL,
  })
}

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

    // Promote deployments the agent reports as actually serving. The control
    // plane schedules; only the node can say whether the container came up, so
    // this is the one place 'deploying' becomes 'running'.
    //
    // "Serving", not "started". A container whose process is up and failing
    // every request used to count as a successful deploy, which is how a broken
    // release replaced a working one and reported success. Where the service
    // has a health check, Docker's verdict is what decides.
    if (hb.containers.length) {
      const pending = await db
        .select({
          id: deployments.id,
          serviceId: deployments.serviceId,
          name: services.name,
          healthDisabled: services.healthDisabled,
        })
        .from(deployments)
        .innerJoin(services, eq(services.id, deployments.serviceId))
        .where(and(eq(deployments.nodeId, nodeId), eq(deployments.status, 'deploying')))

      if (pending.length) {
        // Prefer the deployment id. Agents older than this report only the
        // service name, and matching on that is still better than nothing.
        const byDeployment = new Map(
          hb.containers.filter((c) => c.deployment_id).map((c) => [c.deployment_id!, c])
        )
        const byName = new Map(hb.containers.map((c) => [c.name, c]))

        const promoted = pending.filter((p) => {
          const container = byDeployment.get(p.id) ?? byName.get(p.name)
          if (!container || container.state !== 'running') return false
          // No check configured means the state is the only evidence there is.
          if (p.healthDisabled || !container.health) return true
          return container.health === 'healthy'
        })

        for (const row of promoted) {
          // Promotion is the cutover. The previous release is superseded here
          // rather than when the new one was scheduled, so it keeps serving
          // for the whole time the replacement is starting and being checked.
          await db.transaction(async (tx) => {
            await tx
              .update(deployments)
              .set({ status: 'running', finishedAt: new Date() })
              .where(eq(deployments.id, row.id))

            await tx
              .update(deployments)
              .set({ status: 'superseded', finishedAt: new Date() })
              .where(
                and(
                  eq(deployments.serviceId, row.serviceId),
                  ne(deployments.id, row.id),
                  inArray(deployments.status, ['deploying', 'running'])
                )
              )
          })
          // The route must follow the new deployment's port immediately.
          await invalidateRoutesForService(app.ctx, row.serviceId)
        }

        if (promoted.length) {
          req.log.info({ nodeId, services: promoted.map((p) => p.name) }, 'deployments now running')
        }
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

    // A node that was marked down and is beating again comes back here immediately.
    const [recovered] = await db
      .update(nodes)
      .set({ status: 'online', lastHeartbeatAt: new Date() })
      .where(and(eq(nodes.id, nodeId), eq(nodes.status, 'offline')))
      .returning({ id: nodes.id, name: nodes.name })

    if (recovered) {
      await redis.del(`node:${nodeId}:down`)
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
    } else {
      await db
        .update(nodes)
        .set({ lastHeartbeatAt: new Date() })
        .where(eq(nodes.id, nodeId))
    }

    return { ok: true, interval_sec: app.ctx.config.HEARTBEAT_INTERVAL_SEC }
  })

  /**
   * Desired state. The agent reconciles toward this; it never decides
   * placement itself (tech doc §7).
   */
  app.get('/agent/desired-state', { preHandler: requireAgent }, async (req) => {
    const nodeId = req.agentNodeId!
    const fleetId = req.agentFleetId!

    const rows = await db
      .select({
        serviceId: services.id,
        service: services.name,
        image: services.image,
        imageTags: deployments.imageTags,
        deploymentId: deployments.id,
        hostPort: deployments.hostPort,
        containerPort: services.containerPort,
        healthCheckPath: services.healthCheckPath,
        healthIntervalSec: services.healthIntervalSec,
        healthTimeoutSec: services.healthTimeoutSec,
        healthDisabled: services.healthDisabled,
        volumeName: services.volumeName,
        volumePath: services.volumePath,
        requestRamMb: services.requestRamMb,
        replicas: services.replicas,
        env: services.env,
        secretRefs: services.secretRefs,
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

    // This is the only place a secret is decrypted, and the only place one
    // leaves the control plane. It is safe here for two reasons that must both
    // stay true: the response is scoped to services already placed on the
    // calling node, and the caller proved it is that node with an agent token.
    // A secret that will not resolve is omitted rather than failing the whole
    // response — a container that is already running should not be torn down
    // because somebody deleted a key it was started with. The deploy path is
    // where a missing secret is refused.
    const withEnv = await Promise.all(
      rows.map(async (r) => {
        const { env, missing } = await buildEnv(app.ctx, fleetId, {
          id: r.serviceId,
          env: r.env,
          secretRefs: r.secretRefs,
        })
        if (missing.length) {
          req.log.warn(
            { nodeId, service: r.service, missing },
            'desired state omits secrets that are not set'
          )
        }
        return { row: r, env }
      })
    )

    return {
      node_id: nodeId,
      generated_at: new Date().toISOString(),
      // A registry that nodes reach from outside the LAN has to require
      // credentials, and the node cannot pull without them. Sent on the same
      // terms as a secret: over TLS, to a caller that proved it is this node.
      registry_auth: registryAuth(app.ctx.config),
      services: withEnv.map(({ row: r, env }) => ({
        name: r.service,
        deployment_id: r.deploymentId,
        image: r.image ?? r.imageTags[0] ?? null,
        health_check_path: r.healthCheckPath,
        health_interval_sec: r.healthIntervalSec,
        health_timeout_sec: r.healthTimeoutSec,
        health_disabled: r.healthDisabled,
        host_port: r.hostPort,
        container_port: r.containerPort,
        volume: r.volumeName,
        volume_path: r.volumePath,
        // The RAM the scheduler reserved for this service, so the node can hold
        // it to that. Placement already weights headroom heavily precisely
        // because a node driven into swap takes its neighbours down with it —
        // and then nothing enforced the number it planned around.
        memory_mb: r.requestRamMb,
        replicas: r.replicas,
        env,
      })),
    }
  })
}

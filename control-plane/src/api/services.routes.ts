import { and, eq, desc, inArray } from 'drizzle-orm'
import { z } from 'zod'
import type { FastifyInstance } from 'fastify'
import { services, deployments, nodes, fleets, placementEvents } from '../db/schema.js'
import { parseManifest, ManifestError } from '../manifest/parse.js'
import { syncManifest } from '../manifest/sync.js'
import { place } from '../scheduler/placement.js'
import { fleetSnapshot, toServiceSpec } from '../scheduler/snapshot.js'
import { platformsFor, BuildUnavailableError } from '../build/runner.js'
import { recordAudit } from '../lib/audit.js'
import { ApiError } from './errors.js'
import { requireFleetPermission } from './guards.js'

export async function serviceRoutes(app: FastifyInstance) {
  const { db } = app.ctx

  /** POST /fleets/:fleetId/services — apply a fleet.yaml (FR-4). */
  app.post(
    '/fleets/:fleetId/services',
    { preHandler: requireFleetPermission('service.create') },
    async (req, reply) => {
      const body = z
        .object({ manifest: z.string().min(1, 'manifest is required') })
        .safeParse(req.body)
      if (!body.success) {
        throw ApiError.badRequest('missing_manifest', 'Send the fleet.yaml contents as { manifest }')
      }

      const { fleetId } = req.params as { fleetId: string }

      let parsed
      try {
        parsed = parseManifest(body.data.manifest)
      } catch (err) {
        if (err instanceof ManifestError) {
          // Every problem at once — fixing a manifest one error per deploy is
          // a miserable loop.
          throw ApiError.unprocessable('invalid_manifest', 'fleet.yaml is not valid', err.issues)
        }
        throw err
      }

      const result = await syncManifest(app.ctx, fleetId, req.orgId!, parsed, req.userId)
      return reply.code(200).send({ fleet: parsed.fleet, ...result })
    }
  )

  /** Dry run: validate without touching anything. */
  app.post(
    '/fleets/:fleetId/services/validate',
    { preHandler: requireFleetPermission('service.read') },
    async (req) => {
      const body = z.object({ manifest: z.string().min(1) }).safeParse(req.body)
      if (!body.success) throw ApiError.badRequest('missing_manifest', 'Send { manifest }')

      try {
        const parsed = parseManifest(body.data.manifest)
        return {
          valid: true,
          fleet: parsed.fleet,
          services: parsed.services.map((s) => ({
            name: s.name,
            placement: s.placement,
            ramMb: s.resources.ram,
            arch: s.arch,
          })),
          warnings: parsed.warnings,
        }
      } catch (err) {
        if (err instanceof ManifestError) return { valid: false, issues: err.issues }
        throw err
      }
    }
  )

  app.get(
    '/fleets/:fleetId/services',
    { preHandler: requireFleetPermission('service.read') },
    async (req) => {
      const { fleetId } = req.params as { fleetId: string }
      const rows = await db.select().from(services).where(eq(services.fleetId, fleetId))

      const live = await db
        .select({
          serviceId: deployments.serviceId,
          nodeId: deployments.nodeId,
          nodeName: nodes.name,
          status: deployments.status,
          gitSha: deployments.gitSha,
        })
        .from(deployments)
        .leftJoin(nodes, eq(nodes.id, deployments.nodeId))
        .where(
          and(
            inArray(deployments.serviceId, rows.length ? rows.map((r) => r.id) : ['00000000-0000-0000-0000-000000000000']),
            inArray(deployments.status, ['deploying', 'running', 'pinned_unavailable'])
          )
        )
      const byService = new Map(live.map((d) => [d.serviceId, d]))

      return {
        services: rows.map((s) => ({ ...s, current: byService.get(s.id) ?? null })),
      }
    }
  )

  /**
   * Where would this go, and why? Answers the question before a deploy rather
   * than after, and is the same code path the scheduler actually uses.
   */
  app.get(
    '/services/:serviceId/placement-preview',
    { preHandler: requireServicePermission('service.read') },
    async (req) => {
      const { service, fleetId } = await loadService(app, req.params as { serviceId: string })
      const { nodes: snapshot, placements, antiAffinityBy } = await fleetSnapshot(app.ctx, fleetId)
      const decision = place(toServiceSpec(service), snapshot, placements, antiAffinityBy)
      return { service: service.name, decision }
    }
  )

  /** POST /services/:id/deploy — schedule a deployment (FR-3 build is Phase 2). */
  app.post(
    '/services/:serviceId/deploy',
    { preHandler: requireServicePermission('service.deploy') },
    async (req, reply) => {
      const body = z
        .object({ gitSha: z.string().max(64).optional(), image: z.string().max(512).optional() })
        .parse(req.body ?? {})

      const { service, fleetId, orgId } = await loadService(app, req.params as { serviceId: string })
      const { nodes: snapshot, placements, antiAffinityBy } = await fleetSnapshot(app.ctx, fleetId)

      const decision = place(toServiceSpec(service), snapshot, placements, antiAffinityBy)
      if (decision.outcome !== 'placed') {
        // Exit code 3 in the CLI. The rejection list is the useful part.
        throw new ApiError(422, 'no_eligible_node', decision.summary, {
          rejected: decision.rejected,
          warnings: decision.warnings,
        })
      }

      let image = body.image ?? service.image

      // Build from source when the service has no prebuilt image (FR-3).
      // Every architecture present among *eligible* nodes is built, not just
      // the winner's: a later failover must not be blocked by a missing arch.
      if (!image) {
        if (!service.buildContext) {
          throw ApiError.unprocessable(
            'no_image_or_build',
            `"${service.name}" has neither an image nor a build context.`
          )
        }

        const eligibleArches = [
          ...new Set(
            snapshot
              .filter((n) => n.status === 'online')
              .map((n) => n.arch)
              .filter((a) => !service.compatibleArches.length || service.compatibleArches.includes(a))
          ),
        ]
        const platforms = platformsFor(eligibleArches)
        if (!platforms.length) {
          throw ApiError.unprocessable(
            'no_buildable_platform',
            `No online node in this fleet has an architecture "${service.name}" can be built for.`
          )
        }

        const gitSha = body.gitSha ?? 'latest'
        try {
          const built = await app.ctx.builds.build({
            serviceName: service.name,
            buildContext: service.buildContext,
            gitSha,
            platforms,
            registry: app.ctx.config.REGISTRY_URL ?? '',
          })
          image = built.imageTags[0]!
          req.log.info(
            { service: service.name, platforms, image, durationMs: built.durationMs },
            'multi-arch build complete'
          )
        } catch (err) {
          if (err instanceof BuildUnavailableError) {
            // The build is where most deploys fail, so the message is the
            // product: it names the platforms and the reason, verbatim.
            throw new ApiError(422, 'build_failed', err.message, { platforms })
          }
          throw err
        }
      }

      const deployment = await app.ctx.db.transaction(async (tx) => {
        // Supersede whatever was live, so a service never has two live rows.
        await tx
          .update(deployments)
          .set({ status: 'superseded', finishedAt: new Date() })
          .where(
            and(
              eq(deployments.serviceId, service.id),
              inArray(deployments.status, ['deploying', 'running'])
            )
          )

        const [row] = await tx
          .insert(deployments)
          .values({
            serviceId: service.id,
            gitSha: body.gitSha ?? null,
            nodeId: decision.nodeId,
            status: 'deploying',
            imageTags: [image],
          })
          .returning()

        await tx.insert(placementEvents).values({
          serviceId: service.id,
          fromNodeId: null,
          toNodeId: decision.nodeId,
          reason: 'manual',
          detail: {
            score: decision.candidates[0]?.score,
            breakdown: decision.candidates[0]?.breakdown,
            consideredNodes: decision.candidates.length,
          },
        })

        await recordAudit(tx, {
          orgId,
          actorUserId: req.userId,
          action: 'service.deployed',
          targetType: 'service',
          targetId: service.id,
          metadata: { node: decision.nodeName, image, gitSha: body.gitSha },
        })

        return row!
      })

      return reply.code(201).send({
        deployment: { id: deployment.id, status: deployment.status },
        placedOn: { id: decision.nodeId, name: decision.nodeName },
        score: decision.candidates[0]?.score,
        warnings: decision.warnings,
        note: 'The agent will converge on its next desired-state poll.',
      })
    }
  )

  /** Manual override (§6). */
  app.post(
    '/services/:serviceId/reschedule',
    { preHandler: requireServicePermission('service.reschedule') },
    async (req) => {
      const { service, fleetId, orgId } = await loadService(app, req.params as { serviceId: string })
      if (service.placementPolicy === 'pinned') {
        throw ApiError.unprocessable(
          'service_pinned',
          `"${service.name}" is pinned. Change its placement policy before moving it.`
        )
      }

      const [current] = await db
        .select()
        .from(deployments)
        .where(
          and(eq(deployments.serviceId, service.id), inArray(deployments.status, ['deploying', 'running']))
        )
        .limit(1)
      if (!current) throw ApiError.unprocessable('not_running', `"${service.name}" is not running`)

      const { nodes: snapshot, placements, antiAffinityBy } = await fleetSnapshot(app.ctx, fleetId)
      // Exclude where it is now, or "reschedule" would be a no-op.
      const elsewhere = snapshot.filter((n) => n.id !== current.nodeId)
      const decision = place(toServiceSpec(service), elsewhere, placements, antiAffinityBy)

      if (decision.outcome !== 'placed') {
        throw new ApiError(422, 'no_eligible_node', decision.summary, { rejected: decision.rejected })
      }

      await app.ctx.db.transaction(async (tx) => {
        await tx
          .update(deployments)
          .set({ status: 'superseded', finishedAt: new Date() })
          .where(eq(deployments.id, current.id))
        await tx.insert(deployments).values({
          serviceId: service.id,
          gitSha: current.gitSha,
          imageTags: current.imageTags,
          nodeId: decision.nodeId,
          status: 'deploying',
        })
        await tx.insert(placementEvents).values({
          serviceId: service.id,
          fromNodeId: current.nodeId,
          toNodeId: decision.nodeId,
          reason: 'manual',
          detail: { score: decision.candidates[0]?.score, forced: true },
        })
        await recordAudit(tx, {
          orgId,
          actorUserId: req.userId,
          action: 'service.rescheduled',
          targetType: 'service',
          targetId: service.id,
          metadata: { from: current.nodeId, to: decision.nodeId, reason: 'manual' },
        })
      })

      return { movedTo: { id: decision.nodeId, name: decision.nodeName }, score: decision.candidates[0]?.score }
    }
  )

  app.get(
    '/services/:serviceId/deployments',
    { preHandler: requireServicePermission('service.read') },
    async (req) => {
      const { service } = await loadService(app, req.params as { serviceId: string })
      const rows = await db
        .select({ deployment: deployments, nodeName: nodes.name })
        .from(deployments)
        .leftJoin(nodes, eq(nodes.id, deployments.nodeId))
        .where(eq(deployments.serviceId, service.id))
        .orderBy(desc(deployments.startedAt))
        .limit(50)
      return { deployments: rows.map((r) => ({ ...r.deployment, nodeName: r.nodeName })) }
    }
  )

  /** GET /fleets/:id/placement-map (§6). */
  app.get(
    '/fleets/:fleetId/placement-map',
    { preHandler: requireFleetPermission('fleet.read') },
    async (req) => {
      const { fleetId } = req.params as { fleetId: string }
      const { nodes: snapshot } = await fleetSnapshot(app.ctx, fleetId)

      const live = await db
        .select({
          serviceName: services.name,
          policy: services.placementPolicy,
          nodeId: deployments.nodeId,
          status: deployments.status,
          ramMb: services.requestRamMb,
        })
        .from(deployments)
        .innerJoin(services, eq(services.id, deployments.serviceId))
        .where(
          and(
            eq(services.fleetId, fleetId),
            // A pinned service held on a downed node must stay visible on that
            // node. Dropping it here is how "not moved" becomes "vanished".
            inArray(deployments.status, ['deploying', 'running', 'pinned_unavailable'])
          )
        )

      return {
        nodes: snapshot.map((n) => ({
          id: n.id,
          name: n.name,
          arch: n.arch,
          status: n.status,
          reliabilityTier: n.reliabilityTier,
          ramMb: n.ramMb,
          committedRamMb: n.committedRamMb,
          freeRamMb: Math.max(0, n.ramMb - n.committedRamMb),
          loadFactor: n.loadFactor ?? null,
          services: live
            .filter((s) => s.nodeId === n.id)
            .map((s) => ({ name: s.serviceName, policy: s.policy, status: s.status, ramMb: s.ramMb })),
        })),
        unplaced: live.filter((s) => !s.nodeId).map((s) => s.serviceName),
      }
    }
  )

  /** GET /fleets/:id/events — the unified timeline (§6, PRD 7.6). */
  app.get(
    '/fleets/:fleetId/events',
    { preHandler: requireFleetPermission('events.read') },
    async (req) => {
      const { fleetId } = req.params as { fleetId: string }
      const q = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }).parse(req.query ?? {})

      const rows = await db
        .select({
          id: placementEvents.id,
          at: placementEvents.createdAt,
          service: services.name,
          reason: placementEvents.reason,
          from: placementEvents.fromNodeId,
          to: placementEvents.toNodeId,
          detail: placementEvents.detail,
        })
        .from(placementEvents)
        .innerJoin(services, eq(services.id, placementEvents.serviceId))
        .where(eq(services.fleetId, fleetId))
        .orderBy(desc(placementEvents.createdAt))
        .limit(q.limit)

      const nodeRows = await db.select({ id: nodes.id, name: nodes.name }).from(nodes).where(eq(nodes.fleetId, fleetId))
      const nameOf = new Map(nodeRows.map((n) => [n.id, n.name]))

      return {
        events: rows.map((e) => ({
          id: e.id,
          at: e.at,
          type: 'service.placed',
          service: e.service,
          reason: e.reason,
          from: e.from ? nameOf.get(e.from) ?? e.from : null,
          to: e.to ? nameOf.get(e.to) ?? e.to : null,
          detail: e.detail,
        })),
      }
    }
  )
}

/* ── helpers ─────────────────────────────────────────────────────── */

/**
 * Service routes are keyed by service id, not fleet id, so permission has to
 * be resolved through the service's fleet. Same 404-not-403 rule as elsewhere:
 * a service you cannot see should not be distinguishable from one that does
 * not exist.
 */
function requireServicePermission(permission: Parameters<typeof requireFleetPermission>[0]) {
  return async function guard(req: Parameters<ReturnType<typeof requireFleetPermission>>[0], reply: Parameters<ReturnType<typeof requireFleetPermission>>[1]) {
    const { serviceId } = req.params as { serviceId?: string }
    if (!serviceId) throw ApiError.badRequest('missing_service', 'Route is missing a service id')

    const rows = await req.server.ctx.db
      .select({ fleetId: services.fleetId })
      .from(services)
      .where(eq(services.id, serviceId))
      .limit(1)
    if (!rows[0]) throw ApiError.notFound('Service')

    // Reuse the fleet guard by supplying the fleet the service belongs to.
    ;(req.params as Record<string, string>).fleetId = rows[0].fleetId
    await requireFleetPermission(permission)(req, reply)
  }
}

async function loadService(app: FastifyInstance, params: { serviceId: string }) {
  const rows = await app.ctx.db
    .select({ service: services, orgId: fleets.orgId })
    .from(services)
    .innerJoin(fleets, eq(fleets.id, services.fleetId))
    .where(eq(services.id, params.serviceId))
    .limit(1)
  if (!rows[0]) throw ApiError.notFound('Service')
  return { service: rows[0].service, fleetId: rows[0].service.fleetId, orgId: rows[0].orgId }
}

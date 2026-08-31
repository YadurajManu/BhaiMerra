/**
 * Secret store routes.
 *
 * Everything here is write-and-forget by design: a value goes in, and the only
 * way it comes back out is inside the desired state handed to the agent that
 * runs the container. There is no read endpoint, not even for an owner, and
 * that is a deliberate limit rather than an omission — a store that can hand a
 * credential back to a browser is one XSS away from handing it to everyone.
 */
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import type { FastifyInstance } from 'fastify'
import { services, fleets } from '../db/schema.js'
import { setSecret, listSecrets, deleteSecret, assertValidKey } from '../secrets/store.js'
import { recordAudit } from '../lib/audit.js'
import { ApiError } from './errors.js'
import { requireFleetPermission } from './guards.js'

/** A value big enough for a certificate, bounded so it cannot be a file upload. */
const secretBody = z.object({ value: z.string().min(1).max(64 * 1024) })

export async function secretRoutes(app: FastifyInstance) {
  const { db } = app.ctx

  /** Names and timestamps for the whole fleet, including service overrides. */
  app.get(
    '/fleets/:fleetId/secrets',
    { preHandler: requireFleetPermission('secret.read') },
    async (req) => {
      const { fleetId } = req.params as { fleetId: string }
      const rows = await listSecrets(app.ctx, fleetId)

      // Resolve service ids to names so the caller does not have to.
      const names = new Map(
        (
          await db
            .select({ id: services.id, name: services.name })
            .from(services)
            .where(eq(services.fleetId, fleetId))
        ).map((s) => [s.id, s.name])
      )

      return {
        secrets: rows.map((r) => ({
          key: r.key,
          scope: r.scope,
          service: r.serviceId ? names.get(r.serviceId) ?? null : null,
          createdAt: r.createdAt,
          updatedAt: r.updatedAt,
        })),
      }
    }
  )

  /** Set or replace a fleet-wide value. */
  app.put(
    '/fleets/:fleetId/secrets/:key',
    { preHandler: requireFleetPermission('secret.write') },
    async (req, reply) => {
      const { fleetId, key } = req.params as { fleetId: string; key: string }
      const parsed = secretBody.safeParse(req.body)
      if (!parsed.success) {
        throw ApiError.badRequest('missing_value', 'Send the secret as { value }')
      }
      assertValidKey(key)

      const { created } = await setSecret(app.ctx, { fleetId }, key, parsed.data.value)

      // The key is recorded; the value never is. An audit trail that leaks the
      // thing it is auditing is worse than no audit trail.
      await recordAudit(db, {
        orgId: req.orgId!,
        actorUserId: req.userId,
        action: created ? 'secret.created' : 'secret.updated',
        targetType: 'fleet',
        targetId: fleetId,
        metadata: { key, scope: 'fleet' },
      })

      return reply.code(created ? 201 : 200).send({
        key,
        scope: 'fleet',
        created,
        note: 'Takes effect on the next deploy of any service that references it.',
      })
    }
  )

  app.delete(
    '/fleets/:fleetId/secrets/:key',
    { preHandler: requireFleetPermission('secret.write') },
    async (req) => {
      const { fleetId, key } = req.params as { fleetId: string; key: string }
      const removed = await deleteSecret(app.ctx, { fleetId }, key)
      if (!removed) throw ApiError.notFound(`Secret "${key}"`)

      await recordAudit(db, {
        orgId: req.orgId!,
        actorUserId: req.userId,
        action: 'secret.deleted',
        targetType: 'fleet',
        targetId: fleetId,
        metadata: { key, scope: 'fleet' },
      })

      return { key, removed: true }
    }
  )

  /**
   * Per-service override. Same key, different value, for one service only —
   * the case where a single service talks to a different database than the
   * rest of the fleet.
   */
  app.put(
    '/services/:serviceId/secrets/:key',
    { preHandler: requireServiceSecretPermission('secret.write') },
    async (req, reply) => {
      const { serviceId, key } = req.params as { serviceId: string; key: string }
      const parsed = secretBody.safeParse(req.body)
      if (!parsed.success) {
        throw ApiError.badRequest('missing_value', 'Send the secret as { value }')
      }
      assertValidKey(key)

      const service = await loadServiceFleet(app, serviceId)
      const { created } = await setSecret(
        app.ctx,
        { fleetId: service.fleetId, serviceId },
        key,
        parsed.data.value
      )

      await recordAudit(db, {
        orgId: req.orgId!,
        actorUserId: req.userId,
        action: created ? 'secret.created' : 'secret.updated',
        targetType: 'service',
        targetId: serviceId,
        metadata: { key, scope: 'service', service: service.name },
      })

      return reply.code(created ? 201 : 200).send({
        key,
        scope: 'service',
        service: service.name,
        created,
        note: `Overrides the fleet value for "${service.name}" only.`,
      })
    }
  )

  app.delete(
    '/services/:serviceId/secrets/:key',
    { preHandler: requireServiceSecretPermission('secret.write') },
    async (req) => {
      const { serviceId, key } = req.params as { serviceId: string; key: string }
      const service = await loadServiceFleet(app, serviceId)

      const removed = await deleteSecret(app.ctx, { fleetId: service.fleetId, serviceId }, key)
      if (!removed) throw ApiError.notFound(`Override "${key}" for "${service.name}"`)

      await recordAudit(db, {
        orgId: req.orgId!,
        actorUserId: req.userId,
        action: 'secret.deleted',
        targetType: 'service',
        targetId: serviceId,
        metadata: { key, scope: 'service', service: service.name },
      })

      return { key, service: service.name, removed: true }
    }
  )
}

/* ── helpers ─────────────────────────────────────────────────────── */

async function loadServiceFleet(app: FastifyInstance, serviceId: string) {
  const [row] = await app.ctx.db
    .select({ id: services.id, name: services.name, fleetId: services.fleetId })
    .from(services)
    .where(eq(services.id, serviceId))
    .limit(1)
  if (!row) throw ApiError.notFound('Service')
  return row
}

/**
 * Same 404-not-403 rule as everywhere else: permission is resolved through the
 * service's fleet, and a service you cannot see is indistinguishable from one
 * that does not exist.
 */
function requireServiceSecretPermission(permission: Parameters<typeof requireFleetPermission>[0]) {
  return async function guard(
    req: Parameters<ReturnType<typeof requireFleetPermission>>[0],
    reply: Parameters<ReturnType<typeof requireFleetPermission>>[1]
  ) {
    const { serviceId } = req.params as { serviceId?: string }
    if (!serviceId) throw ApiError.badRequest('missing_service', 'Route is missing a service id')

    const rows = await req.server.ctx.db
      .select({ fleetId: services.fleetId })
      .from(services)
      .innerJoin(fleets, eq(fleets.id, services.fleetId))
      .where(eq(services.id, serviceId))
      .limit(1)
    if (!rows[0]) throw ApiError.notFound('Service')

    ;(req.params as Record<string, string>).fleetId = rows[0].fleetId
    await requireFleetPermission(permission)(req, reply)
  }
}

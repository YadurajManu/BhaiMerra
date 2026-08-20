import { and, eq } from 'drizzle-orm'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { nodes, orgMembers, fleets } from '../db/schema.js'
import { hashToken, isAgentToken } from '../lib/tokens.js'
import { can, type Permission } from '../auth/rbac.js'
import { ApiError } from './errors.js'

function bearer(req: FastifyRequest): string | null {
  const raw = req.headers.authorization
  if (!raw?.startsWith('Bearer ')) return null
  return raw.slice(7).trim() || null
}

/** Verifies a user access token. Refresh tokens are rejected here on purpose. */
export async function requireUser(req: FastifyRequest, _reply: FastifyReply) {
  try {
    await req.jwtVerify()
    const claims = req.user
    if (claims.typ !== 'access') throw ApiError.unauthorized('Access token required')
    req.userId = claims.sub
  } catch (err) {
    if (err instanceof ApiError) throw err
    throw ApiError.unauthorized('Invalid or expired token')
  }
}

/**
 * Resolves the caller's role in the org that owns `:fleetId` and checks the
 * permission. Enforced here rather than in handlers so that adding a route
 * without an explicit permission is a visible omission, not a silent hole.
 */
export function requireFleetPermission(permission: Permission) {
  return async function guard(req: FastifyRequest, reply: FastifyReply) {
    await requireUser(req, reply)

    const { fleetId } = req.params as { fleetId?: string }
    if (!fleetId) throw ApiError.badRequest('missing_fleet', 'Route is missing a fleet id')

    const rows = await req.server.ctx.db
      .select({ orgId: fleets.orgId, role: orgMembers.role })
      .from(fleets)
      .innerJoin(orgMembers, eq(orgMembers.orgId, fleets.orgId))
      .where(and(eq(fleets.id, fleetId), eq(orgMembers.userId, req.userId!)))
      .limit(1)

    const row = rows[0]
    // Deliberately 404, not 403: a fleet you cannot see should not be
    // distinguishable from one that does not exist.
    if (!row) throw ApiError.notFound('Fleet')

    if (!can(row.role, permission)) {
      throw ApiError.forbidden(`Your role (${row.role}) cannot perform ${permission}`)
    }

    req.orgId = row.orgId
    req.orgRole = row.role
  }
}

/**
 * Agent authentication. Every agent request carries its long-lived token; at a
 * 5s heartbeat interval that is a lot of lookups, so a verified token is
 * cached briefly in Redis rather than hitting Postgres on every beat.
 */
export async function requireAgent(req: FastifyRequest, _reply: FastifyReply) {
  const token = bearer(req)
  if (!token || !isAgentToken(token)) throw ApiError.unauthorized('Agent token required')

  const digest = hashToken(token)
  const cacheKey = `agentauth:${digest}`
  const { db, redis } = req.server.ctx

  const cached = await redis.get(cacheKey)
  if (cached) {
    const [nodeId, fleetId] = cached.split(':')
    req.agentNodeId = nodeId
    req.agentFleetId = fleetId
    return
  }

  const rows = await db
    .select({ id: nodes.id, fleetId: nodes.fleetId })
    .from(nodes)
    .where(eq(nodes.agentTokenHash, digest))
    .limit(1)

  const node = rows[0]
  if (!node) throw ApiError.unauthorized('Unrecognised or revoked agent token')

  // Short TTL so a revoked node stops being accepted within a minute.
  await redis.set(cacheKey, `${node.id}:${node.fleetId}`, 'EX', 60)
  req.agentNodeId = node.id
  req.agentFleetId = node.fleetId
}

/** Called on revocation so a cached token stops working immediately. */
export async function invalidateAgentAuth(redis: { del: (k: string) => Promise<number> }, tokenHash: string) {
  await redis.del(`agentauth:${tokenHash}`)
}

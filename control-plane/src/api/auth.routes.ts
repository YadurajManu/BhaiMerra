import { eq } from 'drizzle-orm'
import { z } from 'zod'
import type { FastifyInstance } from 'fastify'
import { users, orgs, orgMembers, fleets } from '../db/schema.js'
import { hashPassword, verifyPassword } from '../auth/passwords.js'
import { issueTokens, consumeRefresh } from '../auth/tokens.js'
import { recordAudit } from '../lib/audit.js'
import { ApiError } from './errors.js'
import { requireUser } from './guards.js'

const credentials = z.object({
  email: z.string().email().max(254).transform((e) => e.toLowerCase().trim()),
  password: z.string().min(12, 'Password must be at least 12 characters').max(1024),
})

export async function authRoutes(app: FastifyInstance) {
  const { db, redis } = app.ctx

  /**
   * Signup provisions the whole starting shape in one transaction: a user, an
   * org they own, and a default fleet. A user with no fleet has nothing to do,
   * and creating it lazily just moves the failure somewhere less obvious.
   */
  app.post('/auth/signup', async (req, reply) => {
    const parsed = credentials.safeParse(req.body)
    if (!parsed.success) {
      throw ApiError.unprocessable('invalid_credentials', 'Check the submitted fields', parsed.error.issues)
    }
    const { email, password } = parsed.data

    const existing = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1)
    if (existing.length) throw ApiError.conflict('email_taken', 'An account with that email already exists')

    const passwordHash = await hashPassword(password)

    const created = await db.transaction(async (tx) => {
      const [user] = await tx.insert(users).values({ email, passwordHash }).returning()
      const orgName = email.split('@')[0] ?? 'personal'
      const [org] = await tx.insert(orgs).values({ name: `${orgName}'s org` }).returning()
      await tx.insert(orgMembers).values({ orgId: org!.id, userId: user!.id, role: 'owner' })
      const [fleet] = await tx.insert(fleets).values({ orgId: org!.id, name: 'homelab' }).returning()

      await recordAudit(tx, {
        orgId: org!.id,
        actorUserId: user!.id,
        action: 'org.created',
        targetType: 'org',
        targetId: org!.id,
        metadata: { via: 'signup' },
      })

      return { user: user!, org: org!, fleet: fleet! }
    })

    const tokens = await issueTokens(app, redis, created.user.id)
    return reply.code(201).send({
      ...tokens,
      user: { id: created.user.id, email: created.user.email },
      org: { id: created.org.id, name: created.org.name },
      fleet: { id: created.fleet.id, name: created.fleet.name },
    })
  })

  app.post('/auth/login', async (req) => {
    const parsed = credentials.safeParse(req.body)
    // Deliberately vague: a validation error here must not reveal whether the
    // email exists or only the password was wrong.
    if (!parsed.success) throw ApiError.unauthorized('Invalid email or password')

    const rows = await db
      .select({ id: users.id, email: users.email, passwordHash: users.passwordHash })
      .from(users)
      .where(eq(users.email, parsed.data.email))
      .limit(1)

    const user = rows[0]
    // Hash even when the user is absent so a missing account is not detectable
    // by response time.
    const ok = user
      ? await verifyPassword(user.passwordHash, parsed.data.password)
      : await verifyPassword('$argon2id$v=19$m=19456,t=2,p=1$AAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', parsed.data.password)

    if (!user || !ok) throw ApiError.unauthorized('Invalid email or password')

    const tokens = await issueTokens(app, redis, user.id)
    return { ...tokens, user: { id: user.id, email: user.email } }
  })

  app.post('/auth/refresh', async (req) => {
    const body = z.object({ refreshToken: z.string().min(1) }).safeParse(req.body)
    if (!body.success) throw ApiError.badRequest('missing_refresh_token', 'refreshToken is required')

    let claims: { sub: string; typ: string; jti?: string }
    try {
      claims = app.jwt.verify(body.data.refreshToken)
    } catch {
      throw ApiError.unauthorized('Invalid or expired refresh token')
    }
    if (claims.typ !== 'refresh' || !claims.jti) {
      throw ApiError.unauthorized('Not a refresh token')
    }

    // Single use. A replayed token finds nothing in Redis and is rejected.
    const userId = await consumeRefresh(redis, claims.jti)
    if (!userId || userId !== claims.sub) {
      throw ApiError.unauthorized('Refresh token has already been used or revoked')
    }

    return issueTokens(app, redis, userId)
  })

  app.get('/auth/me', { preHandler: requireUser }, async (req) => {
    const rows = await db
      .select({ id: users.id, email: users.email, createdAt: users.createdAt })
      .from(users)
      .where(eq(users.id, req.userId!))
      .limit(1)
    if (!rows[0]) throw ApiError.notFound('User')

    const memberships = await db
      .select({ orgId: orgMembers.orgId, orgName: orgs.name, role: orgMembers.role, plan: orgs.plan })
      .from(orgMembers)
      .innerJoin(orgs, eq(orgs.id, orgMembers.orgId))
      .where(eq(orgMembers.userId, req.userId!))

    return { user: rows[0], orgs: memberships }
  })
}

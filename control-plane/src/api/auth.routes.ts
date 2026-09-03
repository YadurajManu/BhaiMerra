import { eq } from 'drizzle-orm'
import { z } from 'zod'
import type { FastifyInstance } from 'fastify'
import { users, orgs, orgMembers, fleets } from '../db/schema.js'
import { hashPassword, verifyPassword } from '../auth/passwords.js'
import { issueTokens, consumeRefresh, revokeAllRefresh } from '../auth/tokens.js'
import {
  issueEmailToken,
  consumeEmailToken,
  withinSendLimit,
  TTL_MS,
} from '../auth/email-tokens.js'
import {
  passwordResetEmail,
  verifyEmail,
  passwordChangedEmail,
  newSignInEmail,
  deletionConfirmEmail,
  deletionScheduledEmail,
  deletionCancelledEmail,
} from '../email/templates.js'
import { recordSignIn, loginContextFrom, describeDevice } from '../auth/sessions.js'
import {
  deletionImpact,
  requestDeletion,
  scheduleDeletion,
  cancelDeletion,
  GRACE_DAYS,
} from '../auth/account-deletion.js'
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

    // Signup returns a working session either way: the address is confirmed
    // so the account can be recovered later, not to gate access on a mail
    // provider being reachable in this exact second.
    await sendVerification(created.user.id, created.user.email)

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

    // Remember the device and tell the owner if this sign-in is unfamiliar.
    // Never let this fail a login: a mail outage must not lock anyone out.
    try {
      const login = loginContextFrom(req.headers as Record<string, unknown>, req.ip)
      const verdict = await recordSignIn(app.ctx, user.id, login)
      req.log.info(
        { userId: user.id, reason: verdict.reason, country: login.country },
        'sign-in recorded'
      )
      if (verdict.isNew) {
        const { subject, body } = newSignInEmail({
          device: describeDevice(verdict.device),
          ip: login.ip,
          country: login.country,
          at: new Date(),
          reason: verdict.reason,
          dashboardUrl: app.ctx.config.PUBLIC_DASHBOARD_URL || undefined,
        })
        await app.ctx.email.send(user.email, subject, body)
      }
    } catch (err) {
      req.log.warn({ err, userId: user.id }, 'sign-in notification failed')
    }

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
      .select({
        id: users.id,
        email: users.email,
        createdAt: users.createdAt,
        // The dashboard gates itself on this. Without it here there is no way
        // for a signed-in client to know the address was never confirmed, and
        // an unverified account gets the whole product - including a recovery
        // flow that mails a link to an address nobody has proven they own.
        emailVerifiedAt: users.emailVerifiedAt,
      })
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

  /* ── password reset and email verification ──────────────────────────
     A forgotten password used to be unrecoverable: no reset path existed,
     so the only fix was editing password_hash in Postgres by hand. */

  const appUrl = () => app.ctx.config.PUBLIC_DASHBOARD_URL?.replace(/\/$/, '') ?? ''

  async function sendVerification(userId: string, email: string) {
    const token = await issueEmailToken(app.ctx, userId, 'email_verify')
    const { subject, body } = verifyEmail(`${appUrl()}/verify?token=${token}`)
    await app.ctx.email.send(email, subject, body).catch((err) => {
      // A signup must not fail because a mail provider is having a bad day.
      app.log.warn({ err, email }, 'verification email failed to send')
    })
  }

  app.post('/auth/forgot', async (req, reply) => {
    const parsed = z
      .object({ email: z.string().email().max(254).transform((e) => e.toLowerCase().trim()) })
      .safeParse(req.body)

    // Always 204, even for a malformed body. Any variation here turns this
    // endpoint into a way to test which addresses have accounts.
    if (!parsed.success) return reply.code(204).send()
    const { email } = parsed.data

    if (!(await withinSendLimit(app.ctx, 'password_reset', email))) {
      // Silent to the caller for the same reason, but loud in the logs: this
      // is what an inbox-flooding attempt through our domain looks like.
      req.log.warn({ email }, 'password reset rate limit hit')
      return reply.code(204).send()
    }

    const [user] = await db
      .select({ id: users.id, email: users.email })
      .from(users)
      .where(eq(users.email, email))
      .limit(1)

    if (user) {
      const token = await issueEmailToken(app.ctx, user.id, 'password_reset')
      const { subject, body } = passwordResetEmail(
        `${appUrl()}/reset?token=${token}`,
        Math.round(TTL_MS.password_reset / 60_000)
      )
      await app.ctx.email.send(user.email, subject, body).catch((err) => {
        req.log.warn({ err }, 'password reset email failed to send')
      })
    }

    return reply.code(204).send()
  })

  app.post('/auth/reset', async (req) => {
    const parsed = z
      .object({
        token: z.string().min(1).max(512),
        password: z.string().min(12, 'Password must be at least 12 characters').max(1024),
      })
      .safeParse(req.body)
    if (!parsed.success) {
      throw ApiError.unprocessable('invalid_reset', 'Check the submitted fields', parsed.error.issues)
    }

    const result = await consumeEmailToken(app.ctx, parsed.data.token, 'password_reset')
    if (!result.ok) {
      // One message for all three reasons. "Expired" rather than "not found"
      // would confirm the token was once real.
      req.log.info({ reason: result.reason }, 'password reset token rejected')
      throw ApiError.unprocessable(
        'invalid_reset',
        'That reset link is no longer valid. Request a new one.'
      )
    }

    const passwordHash = await hashPassword(parsed.data.password)
    const [updated] = await db
      .update(users)
      .set({ passwordHash })
      .where(eq(users.id, result.userId))
      .returning({ id: users.id, email: users.email })

    // Every refresh token for this user dies with the password. A reset is
    // frequently a response to a compromise, and leaving old sessions alive
    // would leave the attacker signed in. Refresh tokens are keyed by jti, not
    // by user, so this needs the scan helper rather than a del.
    const revoked = await revokeAllRefresh(redis, result.userId)
    req.log.info({ revoked }, 'sessions revoked after password reset')

    if (updated) {
      const { subject, body } = passwordChangedEmail(new Date(), appUrl() || undefined)
      await app.ctx.email.send(updated.email, subject, body).catch((err) => {
        req.log.warn({ err }, 'password changed notice failed to send')
      })
    }

    return { ok: true }
  })

  app.post('/auth/verify', async (req) => {
    const parsed = z.object({ token: z.string().min(1).max(512) }).safeParse(req.body)
    if (!parsed.success) throw ApiError.unprocessable('invalid_token', 'Check the submitted fields')

    const result = await consumeEmailToken(app.ctx, parsed.data.token, 'email_verify')
    if (!result.ok) {
      throw ApiError.unprocessable(
        'invalid_token',
        'That confirmation link is no longer valid. Request a new one.'
      )
    }

    await db
      .update(users)
      .set({ emailVerifiedAt: new Date() })
      .where(eq(users.id, result.userId))

    return { ok: true }
  })

  app.post('/auth/resend-verification', { preHandler: requireUser }, async (req, reply) => {
    const [user] = await db
      .select({ id: users.id, email: users.email, verifiedAt: users.emailVerifiedAt })
      .from(users)
      .where(eq(users.id, req.userId!))
      .limit(1)
    if (!user) throw ApiError.notFound('User')
    if (user.verifiedAt) return { ok: true, alreadyVerified: true }

    if (!(await withinSendLimit(app.ctx, 'email_verify', user.email))) {
      throw ApiError.tooManyRequests('rate_limited', 'Too many requests. Try again later.')
    }

    await sendVerification(user.id, user.email)
    return reply.send({ ok: true })
  })

  /* ── closing an account ─────────────────────────────────────────────
     Deliberately slow. Deleting an org cascades to its fleets, and a fleet
     cascades to its nodes, services, deployments, secrets and backups, with
     no undo once it runs. */

  /** What would actually be destroyed. The dashboard shows this before asking. */
  app.get('/account/deletion', { preHandler: requireUser }, async (req) => {
    const [user] = await db
      .select({ scheduledFor: users.deletionScheduledFor })
      .from(users)
      .where(eq(users.id, req.userId!))
      .limit(1)
    return {
      graceDays: GRACE_DAYS,
      scheduledFor: user?.scheduledFor ?? null,
      impact: await deletionImpact(app.ctx, req.userId!),
    }
  })

  /**
   * Ask to close. Requires the password even though the caller is already
   * authenticated: a borrowed laptop with a live session must not be enough to
   * start destroying someone's infrastructure.
   */
  app.post('/account/deletion', { preHandler: requireUser }, async (req, reply) => {
    const parsed = z.object({ password: z.string().min(1).max(1024) }).safeParse(req.body)
    if (!parsed.success) {
      throw ApiError.unprocessable('password_required', 'Confirm your password to continue')
    }

    const [user] = await db
      .select({ id: users.id, email: users.email, passwordHash: users.passwordHash })
      .from(users)
      .where(eq(users.id, req.userId!))
      .limit(1)
    if (!user) throw ApiError.notFound('User')

    if (!(await verifyPassword(user.passwordHash, parsed.data.password))) {
      throw ApiError.unauthorized('That password is not correct')
    }

    if (!(await withinSendLimit(app.ctx, 'password_reset', `del:${user.email}`))) {
      throw ApiError.tooManyRequests('rate_limited', 'Too many requests. Try again later.')
    }

    const impact = await deletionImpact(app.ctx, user.id)
    await requestDeletion(app.ctx, user.id)

    const token = await issueEmailToken(app.ctx, user.id, 'account_delete')
    const { subject, body } = deletionConfirmEmail(
      `${appUrl()}/account/close?token=${token}`,
      impact,
      GRACE_DAYS
    )
    await app.ctx.email.send(user.email, subject, body).catch((err) => {
      req.log.warn({ err }, 'deletion confirmation email failed to send')
    })

    req.log.warn({ userId: user.id }, 'account deletion requested')
    return reply.send({ ok: true, graceDays: GRACE_DAYS, impact })
  })

  /** Confirm from the emailed link. Starts the countdown; deletes nothing yet. */
  app.post('/account/deletion/confirm', async (req) => {
    const parsed = z.object({ token: z.string().min(1).max(512) }).safeParse(req.body)
    if (!parsed.success) throw ApiError.unprocessable('invalid_token', 'Check the submitted fields')

    const result = await consumeEmailToken(app.ctx, parsed.data.token, 'account_delete')
    if (!result.ok) {
      throw ApiError.unprocessable(
        'invalid_token',
        'That confirmation link is no longer valid. Start again from Settings.'
      )
    }

    const impact = await deletionImpact(app.ctx, result.userId)
    const due = await scheduleDeletion(app.ctx, result.userId)

    const [user] = await db
      .select({ email: users.email })
      .from(users)
      .where(eq(users.id, result.userId))
      .limit(1)
    if (user) {
      const { subject, body } = deletionScheduledEmail(due, impact, appUrl() || undefined)
      await app.ctx.email.send(user.email, subject, body).catch((err) => {
        req.log.warn({ err }, 'deletion scheduled email failed to send')
      })
    }

    req.log.warn({ userId: result.userId, due }, 'account deletion scheduled')
    return { ok: true, scheduledFor: due, graceDays: GRACE_DAYS }
  })

  /** Call it off. Signing in at all is enough - cancelling is never the risky direction. */
  app.delete('/account/deletion', { preHandler: requireUser }, async (req) => {
    const cancelled = await cancelDeletion(app.ctx, req.userId!)
    if (cancelled) {
      const [user] = await db
        .select({ email: users.email })
        .from(users)
        .where(eq(users.id, req.userId!))
        .limit(1)
      if (user) {
        const { subject, body } = deletionCancelledEmail()
        await app.ctx.email.send(user.email, subject, body).catch((err) => {
          req.log.warn({ err }, 'deletion cancelled email failed to send')
        })
      }
      req.log.info({ userId: req.userId }, 'account deletion cancelled')
    }
    return { ok: true, cancelled }
  })

  /** Start a CLI web login session. Mints a single-use code stored in Redis. */
  app.post('/auth/cli-session', async (req) => {
    const body = z.object({ port: z.number().int().optional() }).parse(req.body ?? {})
    const { randomBytes } = await import('node:crypto')
    const code = `clisec_${randomBytes(16).toString('hex')}`
    const sessionData = JSON.stringify({ code, port: body.port ?? null, status: 'pending' })
    await redis.set(`cli_session:${code}`, sessionData, 'EX', 600)
    return { code, expiresAt: new Date(Date.now() + 600_000).toISOString() }
  })

  /** Called by the web dashboard to approve a CLI session code for the current user. */
  app.post('/auth/cli-session/approve', { preHandler: requireUser }, async (req) => {
    const body = z.object({ code: z.string().min(1) }).parse(req.body)
    const key = `cli_session:${body.code}`
    const raw = await redis.get(key)
    if (!raw) throw ApiError.notFound('CLI login session has expired or is invalid')

    const tokens = await issueTokens(app, redis, req.userId!)
    const [user] = await db.select({ email: users.email }).from(users).where(eq(users.id, req.userId!)).limit(1)

    const payload = {
      status: 'approved',
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      user: { id: req.userId!, email: user?.email ?? '' },
    }

    // Keep approved tokens in Redis for 5 minutes so CLI polling or callback can fetch them
    await redis.set(key, JSON.stringify(payload), 'EX', 300)
    return payload
  })

  /** Polling fallback endpoint for CLI in remote/SSH/no-callback environments. */
  app.get('/auth/cli-session/:code/poll', async (req) => {
    const { code } = req.params as { code: string }
    const key = `cli_session:${code}`
    const raw = await redis.get(key)
    if (!raw) throw ApiError.notFound('CLI login session expired')

    const session = JSON.parse(raw)
    if (session.status === 'approved') {
      // Consume session so tokens are fetched once
      await redis.del(key)
      return session
    }
    return { status: 'pending' }
  })
}

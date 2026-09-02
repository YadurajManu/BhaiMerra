/**
 * Password reset and email verification tokens.
 *
 * The properties tested here are the ones that make a reset link safe rather
 * than merely functional: it works once, it stops working when a newer one is
 * used, and nothing recoverable is written to the database.
 */
import 'dotenv/config'
import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { eq } from 'drizzle-orm'

import { loadConfig } from '../src/config.js'
import { createContext, closeContext, type AppContext } from '../src/api/context.js'
import { users, orgs, authTokens } from '../src/db/schema.js'
import {
  issueEmailToken,
  consumeEmailToken,
  withinSendLimit,
  hashToken,
  TTL_MS,
} from '../src/auth/email-tokens.js'
import { passwordChangedEmail, passwordResetEmail, verifyEmail } from '../src/email/templates.js'

let ctx: AppContext
let userId: string
let orgId: string

before(async () => {
  ctx = createContext(loadConfig())
  const [org] = await ctx.db.insert(orgs).values({ name: 'token-test-org' }).returning()
  orgId = org!.id
  const [u] = await ctx.db
    .insert(users)
    .values({ email: `tok-${Date.now()}@example.test`, passwordHash: 'x' })
    .returning()
  userId = u!.id
})

after(async () => {
  await ctx.db.delete(authTokens).where(eq(authTokens.userId, userId))
  await ctx.db.delete(users).where(eq(users.id, userId))
  await ctx.db.delete(orgs).where(eq(orgs.id, orgId))
  await closeContext(ctx)
})

describe('email tokens', () => {
  test('the plaintext token is never stored', async () => {
    const token = await issueEmailToken(ctx, userId, 'password_reset')
    const rows = await ctx.db.select().from(authTokens).where(eq(authTokens.userId, userId))
    const row = rows.find((r) => r.tokenHash === hashToken(token))

    assert.ok(row, 'the token should be findable by its hash')
    // A dump of this table must not be a set of working reset links.
    assert.ok(
      !rows.some((r) => r.tokenHash === token),
      'the raw token must not appear in the table'
    )
    assert.equal(row!.tokenHash.length, 64, 'sha256 hex')
  })

  test('redeems once and refuses the second time', async () => {
    const token = await issueEmailToken(ctx, userId, 'password_reset')

    const first = await consumeEmailToken(ctx, token, 'password_reset')
    assert.deepEqual(first, { ok: true, userId })

    const second = await consumeEmailToken(ctx, token, 'password_reset')
    assert.equal(second.ok, false)
    assert.equal(second.ok === false && second.reason, 'already_used')
  })

  test('redeeming one token burns every other outstanding one', async () => {
    // A link mailed an hour ago must stop working the moment a newer one is
    // used, or a reset does not actually close off the older link.
    const older = await issueEmailToken(ctx, userId, 'password_reset')
    const newer = await issueEmailToken(ctx, userId, 'password_reset')

    assert.equal((await consumeEmailToken(ctx, newer, 'password_reset')).ok, true)

    const stale = await consumeEmailToken(ctx, older, 'password_reset')
    assert.equal(stale.ok, false)
    assert.equal(stale.ok === false && stale.reason, 'already_used')
  })

  test('an expired token is refused', async () => {
    const token = await issueEmailToken(ctx, userId, 'password_reset')
    await ctx.db
      .update(authTokens)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(authTokens.tokenHash, hashToken(token)))

    const r = await consumeEmailToken(ctx, token, 'password_reset')
    assert.equal(r.ok, false)
    assert.equal(r.ok === false && r.reason, 'expired')
  })

  test('a token cannot be redeemed for a different purpose', async () => {
    // Otherwise a verification link, which is long-lived and mailed on signup,
    // would be usable to reset a password.
    const token = await issueEmailToken(ctx, userId, 'email_verify')
    const r = await consumeEmailToken(ctx, token, 'password_reset')
    assert.equal(r.ok, false)
    assert.equal(r.ok === false && r.reason, 'not_found')
  })

  test('an unknown token is refused', async () => {
    const r = await consumeEmailToken(ctx, 'not-a-real-token', 'password_reset')
    assert.equal(r.ok, false)
    assert.equal(r.ok === false && r.reason, 'not_found')
  })

  test('reset links are short-lived and verification links are not', () => {
    assert.equal(TTL_MS.password_reset, 30 * 60_000)
    assert.ok(TTL_MS.email_verify > TTL_MS.password_reset)
  })
})

describe('send rate limit', () => {
  test('allows a few then refuses, keyed by address', async () => {
    // Without this, /auth/forgot is a way to flood a stranger's inbox from our
    // verified domain, and our sending reputation pays for it.
    const email = `rate-${Date.now()}@example.test`
    const results: boolean[] = []
    for (let i = 0; i < 5; i++) {
      results.push(await withinSendLimit(ctx, 'password_reset', email, 3, 60))
    }
    assert.deepEqual(results, [true, true, true, false, false])

    // A different address is unaffected.
    assert.equal(await withinSendLimit(ctx, 'password_reset', `other-${Date.now()}@x.test`, 3, 60), true)
  })
})

describe('templates', () => {
  test('the password-changed notice contains no link', () => {
    // A security notice with a login button trains people to click login links
    // in email, which is what credential phishing depends on.
    const { body } = passwordChangedEmail(new Date(), 'https://app.example.com')
    assert.ok(!body.includes('<a '), 'no anchor tags at all')
    assert.ok(!/href=/.test(body), 'no href attributes')
  })

  test('reset and verify emails carry exactly the link they were given', () => {
    const url = 'https://app.example.com/reset?token=abc123'
    const reset = passwordResetEmail(url, 30)
    assert.ok(reset.body.includes(url))
    assert.match(reset.subject, /reset/i)

    const verify = verifyEmail('https://app.example.com/verify?token=xyz')
    assert.ok(verify.body.includes('token=xyz'))
  })

  test('a url is escaped rather than interpolated raw', () => {
    const { body } = passwordResetEmail('https://x.test/reset?token=a"><script>bad()</script>', 30)
    assert.ok(!body.includes('<script>'), 'markup in a url must not become markup')
    assert.ok(body.includes('&lt;script&gt;') || body.includes('&quot;'))
  })
})

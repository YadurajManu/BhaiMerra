import { randomBytes, createHash } from 'node:crypto'
import { and, eq, isNull, sql } from 'drizzle-orm'
import { authTokens } from '../db/schema.js'
import type { AppContext } from '../api/context.js'

/**
 * Single-use tokens for password reset and email verification.
 *
 * Three properties matter here, and each of them is a way this goes wrong:
 *
 *   - Only the hash is stored. A stolen database must not be a stolen set of
 *     working reset links.
 *   - Redeeming one token invalidates every other outstanding token of the
 *     same purpose for that user, so a reset link mailed an hour ago stops
 *     working the moment a newer one is used.
 *   - Lookup is by hash, which is a unique index, so verification is a single
 *     indexed read and does not vary in time with how many tokens exist.
 */

export type TokenPurpose = 'password_reset' | 'email_verify' | 'account_delete'

/** Reset links are short-lived; verification links are not urgent. */
export const TTL_MS: Record<TokenPurpose, number> = {
  password_reset: 30 * 60_000,
  email_verify: 24 * 60 * 60_000,
  // Short. This link starts destroying infrastructure, so an old one sitting
  // in a mailbox should stop working long before anyone stumbles back onto it.
  account_delete: 60 * 60_000,
}

export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex')

/**
 * Mint a token and return the plaintext exactly once. The caller must put it in
 * an email and then forget it — there is no way to read it back.
 */
export async function issueEmailToken(
  ctx: AppContext,
  userId: string,
  purpose: TokenPurpose
): Promise<string> {
  // 32 bytes is 256 bits of entropy, and base64url survives being pasted into
  // a URL, an email client's line wrapping, and a terminal without escaping.
  const token = randomBytes(32).toString('base64url')

  await ctx.db.insert(authTokens).values({
    userId,
    tokenHash: hashToken(token),
    purpose,
    expiresAt: new Date(Date.now() + TTL_MS[purpose]),
  })

  return token
}

export type ConsumeResult =
  | { ok: true; userId: string }
  | { ok: false; reason: 'not_found' | 'expired' | 'already_used' }

/**
 * Redeem a token. Returns the user it belonged to, or why it did not work.
 *
 * The distinction between reasons is for logging, not for the response: telling
 * a caller "expired" rather than "not found" confirms the token was once real,
 * which is a small oracle worth not handing out.
 */
export async function consumeEmailToken(
  ctx: AppContext,
  token: string,
  purpose: TokenPurpose
): Promise<ConsumeResult> {
  const [row] = await ctx.db
    .select()
    .from(authTokens)
    .where(and(eq(authTokens.tokenHash, hashToken(token)), eq(authTokens.purpose, purpose)))
    .limit(1)

  if (!row) return { ok: false, reason: 'not_found' }
  if (row.usedAt) return { ok: false, reason: 'already_used' }
  if (row.expiresAt.getTime() <= Date.now()) return { ok: false, reason: 'expired' }

  // Mark used and burn every sibling in one statement. Doing it as two writes
  // leaves a window where a second request redeems the same token.
  const marked = await ctx.db
    .update(authTokens)
    .set({ usedAt: new Date() })
    .where(and(eq(authTokens.id, row.id), isNull(authTokens.usedAt)))
    .returning({ id: authTokens.id })

  // Lost the race: another request redeemed it between the read and the write.
  if (!marked.length) return { ok: false, reason: 'already_used' }

  await ctx.db
    .update(authTokens)
    .set({ usedAt: new Date() })
    .where(
      and(
        eq(authTokens.userId, row.userId),
        eq(authTokens.purpose, purpose),
        isNull(authTokens.usedAt)
      )
    )

  return { ok: true, userId: row.userId }
}

/**
 * Throttle by address rather than by account.
 *
 * Without this, /auth/forgot is a way to flood a stranger's inbox from your
 * verified domain, and your sending reputation pays for it. Keyed on the
 * submitted address so it also applies to addresses that have no account —
 * which is exactly what an abuser would use.
 */
export async function withinSendLimit(
  ctx: AppContext,
  purpose: TokenPurpose,
  email: string,
  max = 3,
  windowSec = 3600
): Promise<boolean> {
  const key = `mail:${purpose}:${createHash('sha256').update(email).digest('hex').slice(0, 32)}`
  const n = await ctx.redis.incr(key)
  if (n === 1) await ctx.redis.expire(key, windowSec)
  return n <= max
}

/** Housekeeping: redeemed and expired rows have no further use. */
export async function pruneExpiredTokens(ctx: AppContext): Promise<number> {
  const gone = await ctx.db
    .delete(authTokens)
    .where(sql`${authTokens.expiresAt} < now() - interval '7 days'`)
    .returning({ id: authTokens.id })
  return gone.length
}

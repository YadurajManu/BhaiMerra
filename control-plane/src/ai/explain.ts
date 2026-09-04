import { and, eq, isNull, sql } from 'drizzle-orm'
import type { AppContext } from '../api/context.js'
import { deployments, deploymentExplanations, fleets, secrets, services } from '../db/schema.js'
import { openSecret, type SealedSecret } from '../lib/crypto.js'
import { signatureOf, tail, worthExplaining } from './signature.js'
import { explainWith, type Explanation } from './provider.js'

/**
 * Explaining a failed deploy, at most once per distinct failure.
 *
 * The order of the checks below is the entire cost model, so it is worth being
 * explicit about it: cache first, limit second, provider last. A cached answer
 * costs nothing and therefore must not consume anybody's daily allowance —
 * charging someone for reading an answer that already existed is the kind of
 * detail that makes a limit feel arbitrary.
 */

/**
 * Explanations a person may generate per day.
 *
 * Deliberately small. Someone hitting five genuinely distinct build failures in
 * one day has a problem this feature cannot solve, and the limit is the only
 * thing standing between a stuck retry loop and a bill. Cache hits do not
 * count, so in practice this is a limit on *new* failures, not on looking.
 */
export const DAILY_LIMIT = 5

export type ExplainOutcome =
  | { status: 'ok'; summary: string; steps: string[]; cached: boolean; hits: number; model: string }
  | { status: 'not_worth_it'; reason: string }
  | { status: 'disabled'; reason: string }
  | { status: 'rate_limited'; used: number; limit: number; resetsInSec: number }
  | { status: 'failed'; reason: string }

/** Keyed per person per day, in the caller's own timezone-free UTC day. */
const limitKey = (userId: string) =>
  `ai:explain:${userId}:${new Date().toISOString().slice(0, 10)}`

const secondsUntilUtcMidnight = (): number => {
  const now = new Date()
  const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)
  return Math.max(1, Math.round((midnight - now.getTime()) / 1000))
}

/** How many explanations this person has generated today. */
export async function usageToday(ctx: AppContext, userId: string): Promise<number> {
  const raw = await ctx.redis.get(limitKey(userId))
  return raw ? Number(raw) : 0
}

export async function explainDeployment(
  ctx: AppContext,
  opts: { fleetId: string; deploymentId: string; userId: string },
  fetchImpl: typeof fetch = fetch
): Promise<ExplainOutcome> {
  const [row] = await ctx.db
    .select({
      failureReason: deployments.failureReason,
      status: deployments.status,
      serviceName: services.name,
      image: services.image,
      healthPath: services.healthCheckPath,
    })
    .from(deployments)
    .innerJoin(services, eq(services.id, deployments.serviceId))
    .where(and(eq(deployments.id, opts.deploymentId), eq(services.fleetId, opts.fleetId)))
    .limit(1)

  if (!row) return { status: 'failed', reason: 'That deployment is not in this fleet.' }

  if (!worthExplaining(row.failureReason)) {
    // A one-word status is already the explanation. Spending a call to restate
    // "node_down_pinned" as a sentence helps nobody and costs money.
    return {
      status: 'not_worth_it',
      reason: row.failureReason
        ? `"${row.failureReason}" is already the whole reason — there is no log to read.`
        : 'This deployment recorded no failure output.',
    }
  }

  const logTail = tail(row.failureReason!)
  const signature = signatureOf(row.failureReason!)

  // 1. Cache. Free, so it happens before any limit is consulted.
  const [cached] = await ctx.db
    .select()
    .from(deploymentExplanations)
    .where(eq(deploymentExplanations.signature, signature))
    .limit(1)

  if (cached) {
    const [bumped] = await ctx.db
      .update(deploymentExplanations)
      .set({ hits: sql`${deploymentExplanations.hits} + 1` })
      .where(eq(deploymentExplanations.signature, signature))
      .returning({ hits: deploymentExplanations.hits })

    return {
      status: 'ok',
      summary: cached.summary,
      steps: cached.steps,
      cached: true,
      hits: bumped?.hits ?? cached.hits,
      model: cached.model,
    }
  }

  // 2. Is this fleet configured to ask anybody?
  const [fleet] = await ctx.db
    .select({
      enabled: fleets.aiEnabled,
      baseUrl: fleets.aiBaseUrl,
      model: fleets.aiModel,
      keyRef: fleets.aiKeyRef,
    })
    .from(fleets)
    .where(eq(fleets.id, opts.fleetId))
    .limit(1)

  if (!fleet?.enabled) {
    return {
      status: 'disabled',
      reason: 'Explaining failures is off for this fleet. Turn it on in Settings and add a provider key.',
    }
  }
  if (!fleet.baseUrl || !fleet.keyRef) {
    return { status: 'disabled', reason: 'This fleet has no provider configured — add a base URL and key in Settings.' }
  }

  const [keyRow] = await ctx.db
    .select({ encryptedValue: secrets.encryptedValue })
    .from(secrets)
    .where(
      and(
        eq(secrets.fleetId, opts.fleetId),
        eq(secrets.key, fleet.keyRef),
        isNull(secrets.serviceId)
      )
    )
    .limit(1)

  if (!keyRow) {
    return { status: 'disabled', reason: `The provider key "${fleet.keyRef}" is not set for this fleet.` }
  }

  // 3. The limit, consulted only now — when a call is genuinely about to cost
  //    something.
  const key = limitKey(opts.userId)
  const used = await ctx.redis.incr(key)
  if (used === 1) await ctx.redis.expire(key, secondsUntilUtcMidnight())

  if (used > DAILY_LIMIT) {
    return {
      status: 'rate_limited',
      used: used - 1,
      limit: DAILY_LIMIT,
      resetsInSec: secondsUntilUtcMidnight(),
    }
  }

  let apiKey: string
  try {
    apiKey = openSecret(keyRow.encryptedValue as unknown as SealedSecret, ctx.config.SECRETS_MASTER_KEY)
  } catch {
    // A value that will not open means SECRETS_MASTER_KEY changed since it was
    // sealed. Never let ciphertext or the failure detail into the message.
    return { status: 'disabled', reason: `The provider key "${fleet.keyRef}" could not be read — set it again.` }
  }

  let out: Explanation
  try {
    out = await explainWith(
      { baseUrl: fleet.baseUrl, apiKey, model: fleet.model },
      { log: logTail, service: row.serviceName },
      fetchImpl
    )
  } catch (err) {
    // Give the allowance back: nothing was explained, so nothing was spent
    // from the reader's point of view, and a provider outage must not burn a
    // day's worth of attempts.
    await ctx.redis.decr(key)
    return { status: 'failed', reason: (err as Error).message }
  }

  await ctx.db
    .insert(deploymentExplanations)
    .values({
      signature,
      summary: out.summary,
      steps: out.steps,
      model: out.model,
      tokensIn: out.tokensIn,
      tokensOut: out.tokensOut,
    })
    // Two people can hit the same new failure at the same moment; the second
    // insert is a conflict, not an error.
    .onConflictDoNothing()

  return { status: 'ok', summary: out.summary, steps: out.steps, cached: false, hits: 1, model: out.model }
}

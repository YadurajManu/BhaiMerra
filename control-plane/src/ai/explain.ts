import { and, eq, sql } from 'drizzle-orm'
import type { AppContext } from '../api/context.js'
import { deployments, deploymentExplanations, services } from '../db/schema.js'
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
/** Default when AI_DAILY_LIMIT is not set. The operator pays; they choose. */
export const DAILY_LIMIT = 20

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

  // 2. Has whoever runs this control plane configured a provider?
  //
  //    Operator-level rather than per fleet: the person who deployed Fleet
  //    holds the key and pays for the calls. Asking a user to go and find a
  //    provider before they can be told why their build failed would mean
  //    almost nobody ever sees this.
  const { AI_API_KEY: apiKey, AI_BASE_URL: baseUrl, AI_MODEL: model } = ctx.config
  if (!apiKey) {
    return {
      status: 'disabled',
      reason: 'This control plane has no explanation provider configured.',
    }
  }

  // 3. The limit, consulted only now — when a call is genuinely about to cost
  //    something.
  const key = limitKey(opts.userId)
  const used = await ctx.redis.incr(key)
  if (used === 1) await ctx.redis.expire(key, secondsUntilUtcMidnight())

  const limit = ctx.config.AI_DAILY_LIMIT ?? DAILY_LIMIT
  if (used > limit) {
    return {
      status: 'rate_limited',
      used: used - 1,
      limit: DAILY_LIMIT,
      resetsInSec: secondsUntilUtcMidnight(),
    }
  }

  let out: Explanation
  try {
    out = await explainWith(
      { baseUrl, apiKey, model },
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

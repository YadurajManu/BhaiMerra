/**
 * The cost model, asserted.
 *
 * Cache first, limit second, provider last. Each of those orderings is a
 * decision someone could reasonably reverse later without realising what it
 * costs, so each one is pinned here: a cached answer must be free and must not
 * consume an allowance, a provider outage must not burn a day's attempts, and
 * nothing may reach a provider that the fleet did not switch on.
 */
import 'dotenv/config'
import { test, describe, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { eq } from 'drizzle-orm'

import { loadConfig } from '../src/config.js'
import { createContext, closeContext, type AppContext } from '../src/api/context.js'
import { deploymentExplanations, deployments, fleets, orgs, services } from '../src/db/schema.js'
import { explainDeployment, usageToday, DAILY_LIMIT, explanationKey } from '../src/ai/explain.js'
import { signatureOf } from '../src/ai/signature.js'

let ctx: AppContext
let fleetId: string
let deploymentId: string
const userId = `ai-user-${Date.now()}`
/** Unique per run: a stable marker would leave cached rows behind, and the
    next run's "five distinct failures" would all be free cache hits that never
    reach the limit being tested. */
const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
const madeSignatures: string[] = []

/** A realistic build failure, long enough to be worth explaining. */
const FAILURE = `#12 [4/9] RUN npm ci
#12 0.418 npm error \`npm ci\` can only install packages when your package.json and package-lock.json are in sync.
#12 0.419 npm error Missing: fastify@4.28.1 from lock file
#12 ERROR: process "/bin/sh -c npm ci" did not complete successfully: exit code: 1
ERROR: failed to solve: process "/bin/sh -c npm ci" did not complete successfully: exit code: 1`

/** A provider that answers, and counts how often it was asked. */
function provider(body: unknown, status = 200) {
  let calls = 0
  const impl = (async () => {
    calls++
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  }) as unknown as typeof fetch
  return { impl, calls: () => calls }
}

/**
 * An answer in the loop's protocol.
 *
 * Explain no longer reads a log and reasons about the text; it runs the
 * investigation with the question filled in, so a stub has to speak the same
 * JSON the loop expects. This one answers on the first turn without asking for
 * a lookup, which is the shortest legal investigation.
 */
const answer = {
  choices: [
    {
      message: {
        content: JSON.stringify({
          answer: {
            summary: 'The lockfile is out of sync.',
            findings: [{ claim: 'the install step failed', evidence: 'deployments(api) failure reason' }],
            next: ['npm install'],
          },
        }),
      },
    },
  ],
  usage: { prompt_tokens: 800, completion_tokens: 90 },
}

before(async () => {
  ctx = createContext(loadConfig())

  const [org] = await ctx.db.insert(orgs).values({ name: `ai-org-${Date.now()}` }).returning()
  const [fleet] = await ctx.db
    .insert(fleets)
    .values({ orgId: org!.id, name: 'ai-fleet' })
    .returning()
  fleetId = fleet!.id

  const [service] = await ctx.db
    .insert(services)
    .values({ fleetId, name: 'api', project: 'test', requestRamMb: 128 })
    .returning()
  const [deployment] = await ctx.db
    .insert(deployments)
    .values({ serviceId: service!.id, status: 'failed', failureReason: FAILURE, imageTags: [] })
    .returning()
  deploymentId = deployment!.id
})

after(async () => {
  await ctx.db.delete(deploymentExplanations).where(eq(deploymentExplanations.signature, explanationKey(fleetId, FAILURE)))
  for (const sig of madeSignatures) {
    await ctx.db.delete(deploymentExplanations).where(eq(deploymentExplanations.signature, sig))
  }
  await ctx.redis.del(`ai:explain:${userId}:${new Date().toISOString().slice(0, 10)}`)
  await closeContext(ctx)
})

/** Back to "configured and unused" before each case. */
beforeEach(async () => {
  await ctx.db.delete(deploymentExplanations).where(eq(deploymentExplanations.signature, explanationKey(fleetId, FAILURE)))
  await ctx.redis.del(`ai:explain:${userId}:${new Date().toISOString().slice(0, 10)}`)
  // Operator config, not fleet config: whoever runs the control plane holds
  // the key.
  ctx.config.AI_API_KEY = 'sk-test'
  ctx.config.AI_BASE_URL = 'https://agentrouter.org/v1'
  ctx.config.AI_MODEL = 'claude-sonnet-4-8'
})

describe('nothing reaches a provider unless one is configured', () => {
  test('a control plane with no key never calls out', async () => {
    ctx.config.AI_API_KEY = undefined
    const p = provider(answer)

    const out = await explainDeployment(ctx, { fleetId, deploymentId, userId }, p.impl)
    assert.equal(out.status, 'disabled')
    assert.equal(p.calls(), 0, 'an unconfigured control plane must not reach a provider')
    assert.equal(await usageToday(ctx, userId), 0, 'and must not consume an allowance')
  })
})

describe('the cache', () => {
  test('a second ask for the same failure costs nothing', async () => {
    const p = provider(answer)

    const first = await explainDeployment(ctx, { fleetId, deploymentId, userId }, p.impl)
    assert.equal(first.status, 'ok')
    assert.equal(first.status === 'ok' && first.cached, false)
    assert.equal(p.calls(), 1)
    assert.equal(await usageToday(ctx, userId), 1)

    const second = await explainDeployment(ctx, { fleetId, deploymentId, userId }, p.impl)
    assert.equal(second.status, 'ok')
    assert.ok(second.status === 'ok' && second.cached, 'the second must come from cache')
    assert.equal(p.calls(), 1, 'the provider must not be asked twice for one failure')

    // The point of the ordering: reading an answer that already exists is free,
    // so it must not spend a day's allowance.
    assert.equal(await usageToday(ctx, userId), 1, 'a cache hit must not consume the daily limit')
  })

  test('and counts how often the failure has been seen', async () => {
    const p = provider(answer)
    await explainDeployment(ctx, { fleetId, deploymentId, userId }, p.impl)
    const second = await explainDeployment(ctx, { fleetId, deploymentId, userId }, p.impl)
    assert.equal(second.status === 'ok' && second.hits, 2)
  })
})

describe('the daily limit', () => {
  test(`stops at ${DAILY_LIMIT} generated explanations`, async () => {
    // Distinct signatures, so the cache never absorbs them: this is what a
    // person hitting five genuinely different failures looks like.
    const p = provider(answer)
    for (let i = 0; i < DAILY_LIMIT; i++) {
      const [svc] = await ctx.db
        .insert(services)
        .values({ fleetId, name: `svc-${i}-${Date.now()}`, project: 'test', requestRamMb: 128 })
        .returning()
      const [dep] = await ctx.db
        .insert(deployments)
        .values({
          serviceId: svc!.id,
          status: 'failed',
          imageTags: [],
          failureReason: `${FAILURE}\nunique marker ${runId} ${i} zzz`,
        })
        .returning()
      madeSignatures.push(signatureOf(`${FAILURE}\nunique marker ${runId} ${i} zzz`))
      const out = await explainDeployment(ctx, { fleetId, deploymentId: dep!.id, userId }, p.impl)
      assert.equal(out.status, 'ok', `attempt ${i + 1} should succeed`)
      assert.equal(out.cached, false, `attempt ${i + 1} must be a real call, or it proves nothing`)
    }

    const overLimit = await explainDeployment(ctx, { fleetId, deploymentId, userId }, p.impl)
    assert.equal(overLimit.status, 'rate_limited')
    if (overLimit.status === 'rate_limited') {
      assert.equal(overLimit.limit, DAILY_LIMIT)
      assert.ok(overLimit.resetsInSec > 0 && overLimit.resetsInSec <= 86400)
    }
    assert.equal(p.calls(), DAILY_LIMIT, 'nothing may be sent once the limit is reached')
  })

  test('a provider failure gives the allowance back', async () => {
    // A provider outage must not cost someone their day. Nothing was
    // explained, so nothing should have been spent.
    const p = provider({ error: { message: 'upstream is down' } }, 502)
    const out = await explainDeployment(ctx, { fleetId, deploymentId, userId }, p.impl)

    assert.equal(out.status, 'failed')
    assert.equal(await usageToday(ctx, userId), 0, 'a failed call must not consume an attempt')
  })
})

describe('what is not worth asking about', () => {
  test('a one-word failure reason is answered without a model', async () => {
    const [svc] = await ctx.db
      .insert(services)
      .values({ fleetId, name: `drift-${Date.now()}`, project: 'test', requestRamMb: 128 })
      .returning()
    const [dep] = await ctx.db
      .insert(deployments)
      .values({ serviceId: svc!.id, status: 'failed', failureReason: 'node_down_pinned', imageTags: [] })
      .returning()

    const p = provider(answer)
    const out = await explainDeployment(ctx, { fleetId, deploymentId: dep!.id, userId }, p.impl)

    assert.equal(out.status, 'not_worth_it')
    assert.equal(p.calls(), 0, 'restating a status code is not worth a model call')
    assert.equal(await usageToday(ctx, userId), 0)
  })
})

/**
 * The guardrail on the manifest assistant, asserted.
 *
 * The whole design rests on one promise: whatever the model returns is parsed
 * by the same parser the control plane applies with, so a manifest the system
 * would reject never reaches the user and the deterministic draft is returned
 * instead. That promise is worth exactly as much as its test — an untested
 * fallback is a fallback nobody has ever seen work.
 *
 * The allowance is asserted alongside it, because a failed review that still
 * costs an attempt would quietly spend a day's budget on nothing.
 */
import 'dotenv/config'
import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'

import { loadConfig } from '../src/config.js'
import { createContext, closeContext, type AppContext } from '../src/api/context.js'
import { assistManifest, DAILY_LIMIT } from '../src/ai/manifest.js'

let ctx: AppContext

/** A draft the real parser accepts — the floor every outcome falls back to. */
const DRAFT = `fleet: homelab

services:
  web:
    build: .
    placement: flexible
    container_port: 80
    resources: { ram: 512Mi, cpu: 0.5 }
`

const MAP = '## Tree\npackage.json\nDockerfile\n\n## Dockerfile\nFROM nginx:alpine\nEXPOSE 80\n'

/** A provider returning whatever content is given, counting its calls. */
function provider(content: string) {
  let calls = 0
  const impl = (async () => {
    calls++
    return new Response(
      JSON.stringify({
        choices: [{ message: { content } }],
        usage: { prompt_tokens: 900, completion_tokens: 200 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    )
  }) as unknown as typeof fetch
  return { impl, calls: () => calls }
}

const reply = (manifest: string, notes: string[] = []) =>
  JSON.stringify({ manifest, notes })

before(() => {
  ctx = createContext(loadConfig())
  // The assistant only runs when a provider is configured; these tests supply
  // the provider themselves, so the key just has to be non-empty.
  ctx.config = { ...ctx.config, AI_API_KEY: 'test-key' }
})

after(async () => {
  await closeContext(ctx)
})

describe('a manifest the parser would reject never reaches the user', () => {
  test('invalid YAML falls back to the draft, and says why', async () => {
    const user = `assist-invalid-${Date.now()}`
    const { impl, calls } = provider(reply('fleet: homelab\nservices:\n  web:\n  bad: [unclosed\n'))

    const out = await assistManifest(ctx, { userId: user, draft: DRAFT, repoMap: MAP }, impl)

    assert.equal(calls(), 1, 'the provider was asked')
    assert.equal(out.status, 'kept_draft', `expected the draft to be kept, got ${out.status}`)
    if (out.status === 'kept_draft') {
      assert.match(out.reason, /rejected|could not be parsed/i, 'and to say why')
    }
  })

  test('valid YAML that is not a valid manifest also falls back', async () => {
    // This is the one that matters. Malformed YAML is caught by any parser;
    // a well-formed document describing a service with no way to run it is
    // the shape a model actually produces when it drifts, and only the real
    // manifest parser knows the difference.
    const user = `assist-nonsense-${Date.now()}`
    const { impl } = provider(
      reply('fleet: homelab\nservices:\n  web:\n    container_port: 80\n    placement: sideways\n')
    )

    const out = await assistManifest(ctx, { userId: user, draft: DRAFT, repoMap: MAP }, impl)

    assert.equal(out.status, 'kept_draft')
  })

  test('a rejected suggestion does not cost an attempt', async () => {
    // A day's allowance spent on answers nobody ever saw would be the worst
    // of both: charged for the model, and left with the draft.
    const user = `assist-refund-${Date.now()}`
    const bad = provider(reply('fleet: homelab\nservices:\n  web:\n    placement: sideways\n'))
    await assistManifest(ctx, { userId: user, draft: DRAFT, repoMap: MAP }, bad.impl)

    const used = await ctx.redis.get(
      `ai:manifest:${user}:${new Date().toISOString().slice(0, 10)}`
    )
    assert.equal(Number(used ?? 0), 0, 'the refund should have put the attempt back')
  })

  test('a provider that is unreachable keeps the draft rather than failing the command', async () => {
    const user = `assist-down-${Date.now()}`
    const impl = (async () => {
      throw new Error('connect ECONNREFUSED')
    }) as unknown as typeof fetch

    const out = await assistManifest(ctx, { userId: user, draft: DRAFT, repoMap: MAP }, impl)

    assert.equal(out.status, 'kept_draft')
    if (out.status === 'kept_draft') assert.match(out.reason, /ECONNREFUSED/)
  })

  test('a reply that is not JSON at all keeps the draft', async () => {
    const user = `assist-prose-${Date.now()}`
    const { impl } = provider('Sure! Here is your manifest, I hope it helps.')

    const out = await assistManifest(ctx, { userId: user, draft: DRAFT, repoMap: MAP }, impl)
    assert.equal(out.status, 'kept_draft')
  })
})

describe('a valid suggestion is returned', () => {
  test('and is reported as a change only when it differs', async () => {
    const user = `assist-ok-${Date.now()}`
    const corrected = `fleet: homelab

services:
  web:
    build: .
    placement: flexible
    container_port: 8080
    resources: { ram: 512Mi, cpu: 0.5 }
`
    const { impl } = provider(reply(corrected, ['port taken from EXPOSE 8080']))

    const out = await assistManifest(ctx, { userId: user, draft: DRAFT, repoMap: MAP }, impl)

    assert.equal(out.status, 'ok')
    if (out.status === 'ok') {
      assert.ok(out.changed, 'a different manifest is a change')
      assert.match(out.manifest, /container_port: 8080/)
      assert.deepEqual(out.notes, ['port taken from EXPOSE 8080'])
      assert.equal(out.usage.limit, DAILY_LIMIT)
    }
  })

  test('an unchanged manifest is not dressed up as a correction', async () => {
    // Reformatting is not a change, and reporting one would teach people to
    // ignore the notes.
    const user = `assist-same-${Date.now()}`
    const { impl } = provider(reply(DRAFT.replace(/\n+/g, '\n\n')))

    const out = await assistManifest(ctx, { userId: user, draft: DRAFT, repoMap: MAP }, impl)

    assert.equal(out.status, 'ok')
    if (out.status === 'ok') assert.equal(out.changed, false)
  })
})

describe('the draft itself is checked first', () => {
  test('an invalid draft is reported rather than sent to a model', async () => {
    // If `init` produced something the parser rejects, that is a bug in init.
    // Asking a model to paper over it would spend money to hide the bug.
    const user = `assist-baddraft-${Date.now()}`
    const { impl, calls } = provider(reply(DRAFT))

    const out = await assistManifest(
      ctx,
      { userId: user, draft: 'fleet: homelab\nservices:\n  web:\n    placement: sideways\n', repoMap: MAP },
      impl
    )

    assert.equal(out.status, 'kept_draft')
    assert.equal(calls(), 0, 'no provider call for a draft that was already broken')
  })
})

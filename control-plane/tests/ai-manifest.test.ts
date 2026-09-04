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
import { fleets, nodes, orgs } from '../src/db/schema.js'
import { hashToken, newAgentToken } from '../src/lib/tokens.js'

let ctx: AppContext
let fleetId: string

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

before(async () => {
  ctx = createContext(loadConfig())
  // The assistant only runs when a provider is configured; these tests supply
  // the provider themselves, so the key just has to be non-empty.
  ctx.config = { ...ctx.config, AI_API_KEY: 'test-key' }

  // A real fleet with one real node: "node:" is checked against what exists,
  // so a fixture with no nodes would let an invented one through unnoticed.
  const [org] = await ctx.db.insert(orgs).values({ name: `assist-org-${Date.now()}` }).returning()
  const [fleet] = await ctx.db
    .insert(fleets)
    .values({ orgId: org!.id, name: 'assist-fleet' })
    .returning()
  fleetId = fleet!.id
  await ctx.db.insert(nodes).values({
    fleetId,
    name: 'real-node',
    arch: 'amd64',
    cpuCores: 4,
    ramMb: 8192,
    diskMb: 100_000,
    agentTokenHash: hashToken(newAgentToken()),
    status: 'online',
  })
})

after(async () => {
  await closeContext(ctx)
})

describe('a manifest the parser would reject never reaches the user', () => {
  test('invalid YAML falls back to the draft, and says why', async () => {
    const user = `assist-invalid-${Date.now()}`
    const { impl, calls } = provider(reply('fleet: homelab\nservices:\n  web:\n  bad: [unclosed\n'))

    const out = await assistManifest(ctx, { userId: user, fleetId, draft: DRAFT, repoMap: MAP }, impl)

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

    const out = await assistManifest(ctx, { userId: user, fleetId, draft: DRAFT, repoMap: MAP }, impl)

    assert.equal(out.status, 'kept_draft')
  })

  test('a rejected suggestion does not cost an attempt', async () => {
    // A day's allowance spent on answers nobody ever saw would be the worst
    // of both: charged for the model, and left with the draft.
    const user = `assist-refund-${Date.now()}`
    const bad = provider(reply('fleet: homelab\nservices:\n  web:\n    placement: sideways\n'))
    await assistManifest(ctx, { userId: user, fleetId, draft: DRAFT, repoMap: MAP }, bad.impl)

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

    const out = await assistManifest(ctx, { userId: user, fleetId, draft: DRAFT, repoMap: MAP }, impl)

    assert.equal(out.status, 'kept_draft')
    if (out.status === 'kept_draft') assert.match(out.reason, /ECONNREFUSED/)
  })

  test('a reply that is not JSON at all keeps the draft', async () => {
    const user = `assist-prose-${Date.now()}`
    const { impl } = provider('Sure! Here is your manifest, I hope it helps.')

    const out = await assistManifest(ctx, { userId: user, fleetId, draft: DRAFT, repoMap: MAP }, impl)
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

    const out = await assistManifest(ctx, { userId: user, fleetId, draft: DRAFT, repoMap: MAP }, impl)

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

    const out = await assistManifest(ctx, { userId: user, fleetId, draft: DRAFT, repoMap: MAP }, impl)

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
      { userId: user, fleetId, draft: 'fleet: homelab\nservices:\n  web:\n    placement: sideways\n', repoMap: MAP },
      impl
    )

    assert.equal(out.status, 'kept_draft')
    assert.equal(calls(), 0, 'no provider call for a draft that was already broken')
  })
})

describe('questions', () => {
  test('are carried through when the model asks them', async () => {
    // The rules tell the model never to guess, which leaves real gaps — which
    // service owns the public URL, whether a worker should be pinned. Asking
    // is the honest form of not knowing.
    const user = `assist-q-${Date.now()}`
    const { impl } = provider(
      JSON.stringify({
        manifest: DRAFT,
        notes: [],
        questions: [
          {
            id: 'public-service',
            ask: 'Which service should get the public URL?',
            why: 'Two services listen on a port and neither is obviously the front door.',
            options: [
              { value: 'web', label: 'web — the Vite build' },
              { value: 'api', label: 'api — the Express server' },
            ],
          },
        ],
      })
    )

    const out = await assistManifest(ctx, { userId: user, fleetId, draft: DRAFT, repoMap: MAP }, impl)
    assert.equal(out.status, 'ok')
    if (out.status === 'ok') {
      assert.equal(out.questions.length, 1)
      assert.equal(out.questions[0]!.id, 'public-service')
      assert.equal(out.questions[0]!.options.length, 2)
    }
  })

  test('a malformed question is dropped, not fatal', async () => {
    // The manifest is the answer; questions are an extra. One bad entry must
    // not cost the review.
    const user = `assist-badq-${Date.now()}`
    const { impl } = provider(
      JSON.stringify({
        manifest: DRAFT,
        notes: [],
        questions: [
          { id: 'fine', ask: 'A real one?', why: '', options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }] },
          { ask: 'no id, no options' },
          { id: 'lonely', ask: 'One option is not a choice', why: '', options: [{ value: 'x', label: 'X' }] },
        ],
      })
    )

    const out = await assistManifest(ctx, { userId: user, fleetId, draft: DRAFT, repoMap: MAP }, impl)
    assert.equal(out.status, 'ok')
    if (out.status === 'ok') {
      assert.deepEqual(out.questions.map((q) => q.id), ['fine'])
    }
  })

  test('answers are sent to the model as settled, not re-asked', async () => {
    const user = `assist-ans-${Date.now()}`
    let sent = ''
    const impl = (async (_url: string, init: RequestInit) => {
      sent = String(init.body)
      return new Response(
        JSON.stringify({ choices: [{ message: { content: JSON.stringify({ manifest: DRAFT, notes: [] }) } }] }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    }) as unknown as typeof fetch

    await assistManifest(
      ctx,
      { userId: user, fleetId, draft: DRAFT, repoMap: MAP, answers: { 'public-service': 'api' } },
      impl
    )

    assert.match(sent, /public-service/, 'the answer reaches the model')
    assert.match(sent, /ask nothing further/, 'and is framed as settled')
  })
})

describe('a machine is not something a repository can name', () => {
  test('an invented node is refused, and the draft kept', async () => {
    // Exactly what happened. Told to correct a draft against a repository, the
    // model changed `node: CHANGE_ME` to `node: mongo`, because docker-compose
    // had a service by that name. It reads as diligent and is the one
    // inference no repository can support: a container name is not a host.
    //
    // Nothing downstream caught it. The manifest parsed, `apply --dry-run`
    // said valid, and `fleet up` failed on a fleet with no node called mongo.
    const user = `assist-node-${Date.now()}`
    const { impl } = provider(
      reply(`fleet: homelab

services:
  web:
    build: .
    placement: pinned
    container_port: 80
    resources: { ram: 512Mi, cpu: 0.5 }
    node: mongo
`)
    )

    const out = await assistManifest(ctx, { userId: user, fleetId, draft: DRAFT, repoMap: MAP }, impl)

    assert.equal(out.status, 'kept_draft')
    if (out.status === 'kept_draft') {
      assert.match(out.reason, /mongo/, 'name what it tried to use')
      assert.match(out.reason, /real-node/, 'and what it could have used')
    }
  })

  test('a real node is accepted', async () => {
    // The guard must not become a ban: pinning to a node that exists is a
    // correction worth making, and this fleet has one.
    const user = `assist-realnode-${Date.now()}`
    const { impl } = provider(
      reply(`fleet: homelab

services:
  web:
    build: .
    placement: pinned
    container_port: 80
    resources: { ram: 512Mi, cpu: 0.5 }
    node: real-node
`)
    )

    const out = await assistManifest(ctx, { userId: user, fleetId, draft: DRAFT, repoMap: MAP }, impl)
    assert.equal(out.status, 'ok')
  })

  test('the model is told which nodes exist', async () => {
    // It cannot choose correctly without being told, and telling it is what
    // makes the guard a backstop rather than the only defence.
    const user = `assist-told-${Date.now()}`
    let sent = ''
    const impl = (async (_url: string, init: RequestInit) => {
      sent = String(init.body)
      return new Response(
        JSON.stringify({ choices: [{ message: { content: reply(DRAFT) } }] }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    }) as unknown as typeof fetch

    await assistManifest(ctx, { userId: user, fleetId, draft: DRAFT, repoMap: MAP }, impl)
    assert.match(sent, /real-node/, 'the fleet’s node names reach the prompt')
  })
})

describe('source in the repository has to stay built', () => {
  test('a build replaced by a prebuilt image is refused', async () => {
    // What happened to a real café site. docker-compose said
    // `image: nginx:alpine` with `./frontend` mounted into it, and the review
    // read that faithfully: the service *is* that image. On one machine it is.
    // On a node there is no ./frontend to mount, so it came up serving nginx's
    // welcome page — 896 bytes — while every status said running. The manifest
    // was valid, the deploy succeeded, and the site was gone.
    const user = `assist-build-${Date.now()}`
    const { impl } = provider(
      reply(`fleet: homelab

services:
  web:
    image: nginx:alpine
    placement: flexible
    container_port: 80
    resources: { ram: 512Mi, cpu: 0.5 }
`)
    )

    const out = await assistManifest(ctx, { userId: user, fleetId, draft: DRAFT, repoMap: MAP }, impl)

    assert.equal(out.status, 'kept_draft')
    if (out.status === 'kept_draft') {
      assert.match(out.reason, /web/, 'name the service it would have gutted')
      assert.match(out.reason, /built/i)
    }
  })

  test('a service that was already an image is left alone', async () => {
    // The guard is about losing source, not about images. A manifest that
    // never had a build has none to lose, and refusing that would ban a whole
    // legitimate shape.
    const user = `assist-imageok-${Date.now()}`
    const imageDraft = `fleet: homelab

services:
  cache:
    image: redis:7
    placement: flexible
    container_port: 6379
    resources: { ram: 256Mi, cpu: 0.5 }
`
    const { impl } = provider(
      reply(imageDraft.replace('ram: 256Mi', 'ram: 512Mi'), ['raised memory'])
    )

    const out = await assistManifest(
      ctx,
      { userId: user, fleetId, draft: imageDraft, repoMap: MAP },
      impl
    )
    assert.equal(out.status, 'ok')
  })
})

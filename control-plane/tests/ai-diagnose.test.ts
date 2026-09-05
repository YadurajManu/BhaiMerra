/**
 * The loop, and the shape of an honest answer.
 *
 * The model is stubbed throughout. What is being tested is not whether a
 * particular model diagnoses well — that changes with the model — but that the
 * loop calls real tools, stops, and refuses to dress a failure as an answer.
 * A diagnosis that quietly runs forever or invents a finding is worse than no
 * diagnosis, and both are properties of this file rather than of the provider.
 */
import 'dotenv/config'
import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'

import { loadConfig } from '../src/config.js'
import { createContext, closeContext, type AppContext } from '../src/api/context.js'
import { deployments, fleets, nodes, orgs, services } from '../src/db/schema.js'
import { hashToken, newAgentToken } from '../src/lib/tokens.js'
import { diagnose, MAX_CALLS } from '../src/ai/diagnose.js'

let ctx: AppContext
let fleetId: string

/** A provider that plays a fixed script of replies, recording the prompts. */
function scripted(replies: string[]) {
  let turn = 0
  const prompts: string[] = []
  const impl = (async (_url: string, init: RequestInit) => {
    prompts.push(String(init.body))
    const content = replies[Math.min(turn++, replies.length - 1)]!
    return new Response(
      JSON.stringify({ choices: [{ message: { content } }], usage: {} }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    )
  }) as unknown as typeof fetch
  return { impl, turns: () => turn, prompts: () => prompts }
}

before(async () => {
  ctx = createContext(loadConfig())
  ctx.config = { ...ctx.config, AI_API_KEY: 'test-key' }

  const [org] = await ctx.db.insert(orgs).values({ name: `diag-org-${Date.now()}` }).returning()
  const [fleet] = await ctx.db.insert(fleets).values({ orgId: org!.id, name: 'diag' }).returning()
  fleetId = fleet!.id

  const [node] = await ctx.db
    .insert(nodes)
    .values({
      fleetId, name: 'box-1', arch: 'amd64', cpuCores: 4, ramMb: 8192, diskMb: 100_000,
      agentTokenHash: hashToken(newAgentToken()), status: 'online',
    })
    .returning()

  const [svc] = await ctx.db
    .insert(services)
    .values({
      fleetId, name: 'api', project: 'demo', placementPolicy: 'flexible',
      requestRamMb: 512, compatibleArches: ['amd64'],
    })
    .returning()

  // Today's crash loop, as a fixture: the reason is in the row.
  await ctx.db.insert(deployments).values({
    serviceId: svc!.id, nodeId: node!.id, status: 'failed',
    failureReason: 'the container is restarting and never reported healthy within the rollout window',
    startedAt: new Date(Date.now() - 300_000), finishedAt: new Date(Date.now() - 290_000),
  })
})

after(async () => {
  await closeContext(ctx)
})

describe('the diagnosis loop', () => {
  test('calls a real tool and feeds the real result back', async () => {
    // The whole point: the model asks, the control plane answers from its own
    // database, and the answer reaches the next turn. A loop that hallucinated
    // its own tool results would pass every other test in this file.
    const { impl, prompts } = scripted([
      JSON.stringify({ call: { tool: 'deployments', args: { service: 'api' } } }),
      JSON.stringify({
        answer: {
          summary: 'The container is crash looping.',
          findings: [{ claim: 'It never reported healthy', evidence: 'deployments(api) — failed, restarting' }],
          next: ['Read the container logs'],
        },
      }),
    ])

    const out = await diagnose(ctx, { fleetId, question: 'why is api down?' }, impl)

    assert.equal(out.status, 'ok')
    if (out.status === 'ok') {
      assert.deepEqual(out.calls.map((c) => c.tool), ['deployments'])
      assert.equal(out.findings.length, 1)
    }
    // The real failure reason, from the database, reached the second turn.
    assert.match(prompts()[1]!, /never reported healthy/)
  })

  test('a tool that errors keeps the investigation going', async () => {
    // "That service does not exist" is a finding. A loop that gave up on the
    // first refusal would stop exactly where the answer often is.
    const { impl, turns } = scripted([
      JSON.stringify({ call: { tool: 'deployments', args: { service: 'ghost' } } }),
      JSON.stringify({
        answer: { summary: 'No such service.', findings: [], next: ['Check the name'] },
      }),
    ])

    const out = await diagnose(ctx, { fleetId, question: 'why is ghost down?' }, impl)
    assert.equal(out.status, 'ok')
    assert.equal(turns(), 2, 'it asked again after the tool refused')
  })

  test('it stops, and says what it looked at', async () => {
    // An agent looping on a fleet's data is a bill, not an investigation. What
    // it managed to look at is still worth reporting.
    const { impl } = scripted([JSON.stringify({ call: { tool: 'nodes', args: {} } })])

    const out = await diagnose(ctx, { fleetId, question: 'why is everything broken?' }, impl)

    assert.equal(out.status, 'inconclusive')
    if (out.status === 'inconclusive') {
      assert.equal(out.calls.length, MAX_CALLS, 'bounded')
      assert.match(out.reason, /Stopped after/)
    }
  })

  test('a reply that is neither a call nor an answer is not dressed up as one', async () => {
    const { impl } = scripted(['I think the service is probably fine, honestly.'])
    const out = await diagnose(ctx, { fleetId, question: 'why is api down?' }, impl)
    assert.equal(out.status, 'inconclusive')
  })

  test('findings without evidence are dropped', async () => {
    // A claim you cannot point at is a guess, and a guess in a diagnosis is
    // worse than no diagnosis.
    const { impl } = scripted([
      JSON.stringify({
        answer: {
          summary: 'Something is wrong.',
          findings: [
            { claim: 'The node is down', evidence: 'nodes() — status offline' },
            { claim: 'The disk is full' },
          ],
          next: [],
        },
      }),
    ])

    const out = await diagnose(ctx, { fleetId, question: 'why?' }, impl)
    assert.equal(out.status, 'ok')
    if (out.status === 'ok') {
      assert.deepEqual(out.findings.map((f) => f.claim), ['The node is down'])
    }
  })

  test('a provider outage is reported as one, with what was gathered', async () => {
    const impl = (async () => {
      throw new Error('connect ECONNREFUSED')
    }) as unknown as typeof fetch

    const out = await diagnose(ctx, { fleetId, question: 'why is api down?' }, impl)
    assert.equal(out.status, 'inconclusive')
    if (out.status === 'inconclusive') assert.match(out.reason, /ECONNREFUSED/)
  })

  test('nothing runs without a provider configured', async () => {
    const bare = { ...ctx, config: { ...ctx.config, AI_API_KEY: undefined } } as AppContext
    const out = await diagnose(bare, { fleetId, question: 'why?' })
    assert.equal(out.status, 'disabled')
  })

  test('a reply that is one object followed by prose is still read', async () => {
    // "Unexpected non-whitespace character after JSON at position 70" ended a
    // real investigation one step in. Everything between the first brace and
    // the last is not the first object: a trailing sentence, or a second
    // object, slices into something that parses as neither.
    const provider = scripted([
      '{"lookup":{"name":"services","args":{}}}\n\nI will check the services first.',
      '{"answer":{"summary":"nothing is running","findings":[],"next":[]}}',
    ])
    const out = await diagnose(ctx, { fleetId, question: 'what is wrong?' }, provider.impl)

    assert.equal(out.status, 'ok')
    if (out.status !== 'ok') return
    assert.deepEqual(out.calls.map((c) => c.tool), ['services'], 'the object before the prose is the step')
  })

  test('an unreadable reply costs a turn, not the whole investigation', async () => {
    // Four good tool calls thrown away over one formatting slip is the wrong
    // trade. It gets told what was wrong and answers again -- once.
    const provider = scripted([
      '{"lookup":{"name":"services","args":{}}}',
      'I think the problem is the database.',
      '{"answer":{"summary":"the database is down","findings":[],"next":[]}}',
    ])
    const out = await diagnose(ctx, { fleetId, question: 'what is wrong?' }, provider.impl)

    assert.equal(out.status, 'ok', 'a slip in the middle should not end it')
    if (out.status !== 'ok') return
    assert.equal(out.calls.length, 1, 'the call made before the slip is kept')
    assert.match(provider.prompts()[2]!, /could not be read/, 'and it is told what was wrong')
  })

  test('two unreadable replies in a row stop, rather than retrying for ever', async () => {
    // A model that cannot hold the protocol will not find it on the third ask,
    // and an agent looping on a fleet's data is a bill, not an investigation.
    const provider = scripted(['no JSON here at all'])
    const out = await diagnose(ctx, { fleetId, question: 'what is wrong?' }, provider.impl)

    assert.equal(out.status, 'inconclusive')
    assert.equal(provider.turns(), 2, 'one retry, then stop')
  })

  test('an editable fix comes back ready to apply', async () => {
    const provider = scripted([
      JSON.stringify({
        answer: {
          summary: 'the health check asks for a path the app does not serve',
          findings: [{ claim: 'probe returns 404', evidence: 'probe(api)' }],
          next: ['remove the health check'],
          fix: { service: 'api', field: 'health', value: null, why: 'nothing answers 2xx' },
        },
      }),
    ])
    const out = await diagnose(ctx, { fleetId, question: 'why?' }, provider.impl)
    assert.equal(out.status, 'ok')
    if (out.status !== 'ok') return
    assert.equal(out.fix?.applicable, true)
    assert.equal(out.fix?.field, 'health')
  })

  test('a rename is returned refused, not applicable', async () => {
    // The first real candidate for an automatic fix was exactly this: an app
    // connecting to the hostname "redis" against a database the manifest named
    // "cache". The diagnosis is right and the fix is a rename, which points a
    // service at a new volume — harmless for a cache, data loss for a database,
    // and not a distinction to leave to a model. It is reported in words and
    // never offered as a button.
    const provider = scripted([
      JSON.stringify({
        answer: {
          summary: 'the app connects to a hostname no service answers to',
          findings: [{ claim: 'vote cannot resolve redis', evidence: 'logs(vote)' }],
          next: ['rename the database'],
          fix: { service: 'cache', field: 'name', value: 'redis', why: 'the app hardcodes this host' },
        },
      }),
    ])
    const out = await diagnose(ctx, { fleetId, question: 'why?' }, provider.impl)
    assert.equal(out.status, 'ok')
    if (out.status !== 'ok') return
    assert.equal(out.fix?.applicable, false, 'a rename must never be applied automatically')
    assert.match(out.fix!.reason!, /volume/, 'and the refusal says what the risk is')
  })

  test('an answer with no fix is still an answer', async () => {
    // Most investigations end without one exact manifest change, and a loop
    // that felt obliged to produce a fix would invent one.
    const provider = scripted([
      JSON.stringify({
        answer: { summary: 'the node was offline at the time', findings: [], next: ['nothing to do'] },
      }),
    ])
    const out = await diagnose(ctx, { fleetId, question: 'why?' }, provider.impl)
    assert.equal(out.status, 'ok')
    if (out.status !== 'ok') return
    assert.equal(out.fix, undefined)
  })

  test('it is told when its lookups are running out', async () => {
    // The loop used to run to exhaustion without warning, and a model that does
    // not know its budget cannot spend it: a real question made eight
    // individually reasonable lookups and never stopped to answer. Knowing the
    // last step is the last one turns that into a partial answer, which with
    // evidence is worth far more than "stopped after 12 calls".
    const provider = scripted(['{"lookup":{"name":"services","args":{}}}'])
    await diagnose(ctx, { fleetId, question: 'why?' }, provider.impl)

    const last = provider.prompts().at(-1)!
    assert.match(last, /last lookup/, 'the final turn must say it is the final turn')
  })

  test('older lookup results are compacted out of the conversation', async () => {
    // The whole conversation is resent every turn, so each result is paid for
    // once per remaining step. Twelve steps of untrimmed results is what took a
    // real investigation past a free tier's 8000 tokens a minute — the loop
    // stopped not because it had nothing left to ask but because it could no
    // longer afford to ask it.
    const provider = scripted(['{"lookup":{"name":"services","args":{}}}'])
    await diagnose(ctx, { fleetId, question: 'why?' }, provider.impl)

    const last = provider.prompts().at(-1)!
    const seen = (last.match(/already seen/g) ?? []).length
    assert.ok(seen > 0, 'the early results should have been shrunk by the final turn')

    // And the most recent ones survive intact, or the investigation is reasoning
    // about nothing.
    assert.match(last, /Result of services/, 'recent evidence stays in full')
  })

  test('the step protocol is sent as a schema, not only asked for in words', async () => {
    // Asking does not work. Groq refused a request outright with "Tool choice
    // is none, but model called a tool", and a local Gemma answered
    // `<|tool_call>call:services{}<tool_call|>` in place of the JSON the prompt
    // requested. Both produce exactly the right object when handed a schema.
    const provider = scripted(['{"answer":{"summary":"fine","findings":[],"next":[]}}'])
    await diagnose(ctx, { fleetId, question: 'why?' }, provider.impl)

    const sent = JSON.parse(provider.prompts()[0]!)
    assert.equal(sent.response_format?.type, 'json_schema')
    assert.equal(sent.response_format?.json_schema?.name, 'step')
  })

  test('a provider that cannot constrain output is asked again without one', async () => {
    // Not universal, and refusing to work against an endpoint that lacks it
    // would trade a real capability for a nicety.
    let calls = 0
    const impl = (async (_url: string, init: RequestInit) => {
      calls++
      const body = JSON.parse(String(init.body))
      if (body.response_format) {
        return new Response(
          JSON.stringify({ error: { message: 'response_format is not supported' } }),
          { status: 400, headers: { 'content-type': 'application/json' } }
        )
      }
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: '{"answer":{"summary":"fine","findings":[],"next":[]}}' } }],
          usage: {},
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    }) as unknown as typeof fetch

    const out = await diagnose(ctx, { fleetId, question: 'why?' }, impl)
    assert.equal(out.status, 'ok', 'the investigation must survive a provider without schemas')
    assert.equal(calls, 2, 'once with, once without')
  })
})

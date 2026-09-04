/**
 * Talking to a provider, without ever talking to one.
 *
 * Every response here is stubbed. A test suite that makes real model calls is
 * a suite that costs money to run, fails when a key expires, and cannot assert
 * anything about the replies it gets — so what is pinned down instead is the
 * handling: what happens when the provider is slow, wrong, fenced, or broke.
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { explainWith } from '../src/ai/provider.js'

const CONFIG = { baseUrl: 'https://agentrouter.org/v1', apiKey: 'sk-test', model: 'claude-sonnet-4-8' }
const CONTEXT = { log: 'npm error Missing: fastify from lock file', service: 'api' }

/** A provider that replies with whatever it is handed. */
function stub(body: unknown, status = 200) {
  const calls: Array<{ url: string; init: RequestInit }> = []
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init! })
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })
  }) as unknown as typeof fetch
  return { impl, calls }
}

const reply = (content: string, usage = { prompt_tokens: 900, completion_tokens: 120 }) => ({
  choices: [{ message: { content } }],
  usage,
})

describe('explainWith', () => {
  test('sends one chat completion and reads the answer back', async () => {
    const { impl, calls } = stub(
      reply('{"summary":"npm ci failed: the lockfile is out of sync.","steps":["npm install","git commit -am sync"]}')
    )
    const out = await explainWith(CONFIG, CONTEXT, impl)

    assert.equal(out.summary, 'npm ci failed: the lockfile is out of sync.')
    assert.deepEqual(out.steps, ['npm install', 'git commit -am sync'])
    assert.equal(out.tokensIn, 900)
    assert.equal(out.tokensOut, 120)

    assert.equal(calls.length, 1, 'exactly one call — a failed explanation is not worth a second charge')
    assert.equal(calls[0]!.url, 'https://agentrouter.org/v1/chat/completions')
    const sent = JSON.parse(String(calls[0]!.init.body)) as Record<string, unknown>
    assert.equal(sent.model, 'claude-sonnet-4-8')
    // Reading a log is not creative writing: the same failure must not produce
    // a different answer each time it is asked.
    assert.ok((sent.temperature as number) <= 0.2)
  })

  test('a trailing slash on the base URL does not double up', async () => {
    const { impl, calls } = stub(reply('{"summary":"x","steps":[]}'))
    await explainWith({ ...CONFIG, baseUrl: 'https://agentrouter.org/v1/' }, CONTEXT, impl)
    assert.equal(calls[0]!.url, 'https://agentrouter.org/v1/chat/completions')
  })

  test('accepts JSON the model wrapped in a code fence', async () => {
    // Models do this constantly, whatever the instruction says.
    const { impl } = stub(reply('```json\n{"summary":"fenced","steps":["a"]}\n```'))
    const out = await explainWith(CONFIG, CONTEXT, impl)
    assert.equal(out.summary, 'fenced')
  })

  test('accepts JSON with prose around it', async () => {
    const { impl } = stub(reply('Here you go:\n{"summary":"padded","steps":[]}\nHope that helps!'))
    const out = await explainWith(CONFIG, CONTEXT, impl)
    assert.equal(out.summary, 'padded')
  })

  test('the manifest is included when there is one', async () => {
    const { impl, calls } = stub(reply('{"summary":"x","steps":[]}'))
    await explainWith(CONFIG, { ...CONTEXT, manifest: 'build: ./api' }, impl)
    const sent = JSON.parse(String(calls[0]!.init.body)) as { messages: Array<{ content: string }> }
    assert.match(sent.messages[1]!.content, /build: \.\/api/)
  })

  test("surfaces the provider's own message, not just a status", async () => {
    // 401 with "insufficient credit" and 401 with "invalid key" need different
    // actions from whoever is looking at it.
    const { impl } = stub({ error: { message: 'insufficient credit' } }, 402)
    await assert.rejects(
      () => explainWith(CONFIG, CONTEXT, impl),
      /402.*insufficient credit/
    )
  })

  test('refuses a reply that is not JSON rather than inventing one', async () => {
    const { impl } = stub(reply('I think your lockfile is probably out of date.'))
    await assert.rejects(() => explainWith(CONFIG, CONTEXT, impl), /did not return JSON/)
  })

  test('refuses a reply with no summary', async () => {
    const { impl } = stub(reply('{"steps":["do a thing"]}'))
    await assert.rejects(() => explainWith(CONFIG, CONTEXT, impl), /no summary/)
  })

  test('drops junk out of steps rather than rendering it', async () => {
    const { impl } = stub(reply('{"summary":"s","steps":["ok", "", null, 42, "  ", "also ok"]}'))
    const out = await explainWith(CONFIG, CONTEXT, impl)
    assert.deepEqual(out.steps, ['ok', 'also ok'])
  })

  test('an empty steps array is a valid answer', async () => {
    // The instruction tells the model to return none when the log does not say
    // enough. That has to survive as "no steps", not become an error.
    const { impl } = stub(reply('{"summary":"The log is truncated before the error.","steps":[]}'))
    const out = await explainWith(CONFIG, CONTEXT, impl)
    assert.deepEqual(out.steps, [])
    assert.match(out.summary, /truncated/)
  })

  test('missing usage counts as zero rather than throwing', async () => {
    // Not every provider reports usage. The meter should under-report, never
    // break the feature.
    const { impl } = stub({ choices: [{ message: { content: '{"summary":"s","steps":[]}' } }] })
    const out = await explainWith(CONFIG, CONTEXT, impl)
    assert.equal(out.tokensIn, 0)
    assert.equal(out.tokensOut, 0)
  })
})

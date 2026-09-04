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

  test('names a bot-detection page instead of calling it empty', async () => {
    // What actually happened: agentrouter.org answered this control plane's
    // requests with an Aliyun WAF challenge -- HTTP 200, text/html -- while
    // the same key returned proper JSON from a laptop. The old code turned
    // any non-JSON body into {} and reported "provider returned no content",
    // which is true and sends whoever reads it to check the model name and
    // the API key, neither of which was the problem.
    const html = '<!doctype html>\n<meta name="aliyun_waf_aa" content="ff92">\n<script>...</script>'
    const impl = (async () =>
      new Response(html, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } })) as unknown as typeof fetch

    await assert.rejects(
      () => explainWith(CONFIG, CONTEXT, impl),
      (err: Error) => {
        assert.match(err.message, /text\/html/, 'the operator needs to know what came back')
        assert.match(err.message, /bot-detection|WAF/i, 'and what that usually means')
        assert.ok(!/no content/.test(err.message), 'the old message pointed at the wrong thing')
        return true
      }
    )
  })

  test('a non-JSON error body is still reported as itself', async () => {
    // A proxy returning a plain-text 502 is not a challenge page, and should
    // not be described as one.
    const impl = (async () =>
      new Response('upstream timed out', { status: 502, headers: { 'content-type': 'text/plain' } })) as unknown as typeof fetch

    await assert.rejects(
      () => explainWith(CONFIG, CONTEXT, impl),
      (err: Error) => {
        assert.match(err.message, /text\/plain/)
        assert.match(err.message, /upstream timed out/)
        assert.ok(!/bot-detection/i.test(err.message), 'no diagnosis that was not earned')
        return true
      }
    )
  })

  test('truncation is reported as truncation, not as emptiness', async () => {
    // A reasoning model that spends its whole completion budget thinking
    // returns HTTP 200, valid JSON, finish_reason "length", and an empty
    // content field. gpt-oss-120b on Groq does exactly this: 25 of 30 tokens
    // went to reasoning on a trivial prompt. "provider returned no content"
    // describes it accurately and explains nothing.
    const impl = (async () =>
      new Response(
        JSON.stringify({ choices: [{ message: { content: '', reasoning: 'thinking…' }, finish_reason: 'length' }] }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )) as unknown as typeof fetch

    await assert.rejects(
      () => explainWith(CONFIG, CONTEXT, impl),
      (err: Error) => {
        assert.match(err.message, /ran out of tokens/, 'name the actual cause')
        assert.match(err.message, /max_tokens|reasoning/i, 'and what to do about it')
        return true
      }
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

describe('a rate limit that says when to come back', () => {
  test('is waited out once, from the prose when there is no header', async () => {
    // Groq answers 429 with "Please try again in 8.25s" and no Retry-After.
    // Failing instead threw away an answer the user had just typed into an
    // interactive prompt — the second call landed seconds after the first and
    // both counted against the same per-minute budget.
    let calls = 0
    const impl = (async () => {
      calls++
      if (calls === 1) {
        return new Response(
          JSON.stringify({
            error: { message: 'Rate limit reached ... Please try again in 0.05s.' },
          }),
          { status: 429, headers: { 'content-type': 'application/json' } }
        )
      }
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: '{"summary":"ok","steps":[]}' } }],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    }) as unknown as typeof fetch

    const out = await explainWith(CONFIG, CONTEXT, impl)
    assert.equal(calls, 2, 'it should have waited and asked again')
    assert.equal(out.summary, 'ok')
  })

  test('is waited out only once', async () => {
    // A provider that is still limited after the wait is limited for longer
    // than we should sit here. Retrying forever would hold an interactive
    // command open with nothing to show for it.
    let calls = 0
    const impl = (async () => {
      calls++
      return new Response(
        JSON.stringify({ error: { message: 'Rate limit reached. Please try again in 0.05s.' } }),
        { status: 429, headers: { 'content-type': 'application/json' } }
      )
    }) as unknown as typeof fetch

    await assert.rejects(() => explainWith(CONFIG, CONTEXT, impl), /429/)
    assert.equal(calls, 2, 'one attempt, one retry, then report it')
  })

  test('a rate limit with no wait given is not retried', async () => {
    // Without a stated wait there is no number to honour, and guessing one is
    // how a command hangs for reasons nobody can see.
    let calls = 0
    const impl = (async () => {
      calls++
      return new Response(JSON.stringify({ error: { message: 'slow down' } }), {
        status: 429,
        headers: { 'content-type': 'application/json' },
      })
    }) as unknown as typeof fetch

    await assert.rejects(() => explainWith(CONFIG, CONTEXT, impl))
    assert.equal(calls, 1)
  })
})

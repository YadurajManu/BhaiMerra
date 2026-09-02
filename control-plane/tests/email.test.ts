/**
 * Email delivery.
 *
 * These are pure unit tests with a stubbed fetch: no database, no network, and
 * deliberately no real Resend call. The behaviour worth pinning down is what
 * happens when Resend misbehaves, because the email branch of `deliver()` gets
 * a single attempt where a webhook gets three.
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { ResendEmailSender } from '../src/email/resend.js'
import { LoggingEmailSender, createEmailSender } from '../src/email/sender.js'
import type { Config } from '../src/config.js'

type Call = { url: string; init: RequestInit }

/** A fetch stub that records calls and replays a queue of responses. */
function stubFetch(responses: Array<{ status: number; body?: string }>) {
  const calls: Call[] = []
  let i = 0
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    const r = responses[Math.min(i++, responses.length - 1)]!
    return new Response(r.body ?? '{"id":"abc"}', { status: r.status })
  }) as unknown as typeof fetch
  return { impl, calls }
}

const bodyOf = (c: Call) => JSON.parse(String(c.init.body)) as Record<string, string>
const cfg = (over: Partial<Config> = {}) => ({ ...over }) as Config

describe('ResendEmailSender', () => {
  test('posts to Resend with the configured from address', async () => {
    const { impl, calls } = stubFetch([{ status: 200 }])
    await new ResendEmailSender('key', 'fleet@yaduraj.me', impl).send(
      'someone@example.com',
      '[fleet-os] node down',
      'kakashi stopped answering'
    )

    assert.equal(calls.length, 1)
    assert.equal(calls[0]!.url, 'https://api.resend.com/emails')
    const b = bodyOf(calls[0]!)
    assert.equal(b.from, 'fleet@yaduraj.me')
    assert.equal(b.to, 'someone@example.com')
    assert.equal(
      (calls[0]!.init.headers as Record<string, string>).authorization,
      'Bearer key'
    )
  })

  test('sends a text part and an html part', async () => {
    // A text-only message is markedly more likely to be filed as spam, and an
    // alert is the one that most needs to arrive.
    const { impl, calls } = stubFetch([{ status: 200 }])
    await new ResendEmailSender('k', 'f@x.dev', impl).send('a@b.co', 's', 'line one\n\nline two')
    const b = bodyOf(calls[0]!)
    assert.equal(b.text, 'line one\n\nline two')
    assert.match(b.html!, /line one/)
    assert.match(b.html!, /line two/)
  })

  test('escapes html so an event detail cannot inject markup', async () => {
    const { impl, calls } = stubFetch([{ status: 200 }])
    await new ResendEmailSender('k', 'f@x.dev', impl)
      .send('a@b.co', 's', 'reason: <script>alert(1)</script>')
    const b = bodyOf(calls[0]!)
    assert.ok(!b.html!.includes('<script>'), 'raw script tag must not survive')
    assert.match(b.html!, /&lt;script&gt;/)
  })

  test('passes a body that is already html through untouched', async () => {
    const { impl, calls } = stubFetch([{ status: 200 }])
    await new ResendEmailSender('k', 'f@x.dev', impl).send('a@b.co', 's', '<p>already markup</p>')
    const b = bodyOf(calls[0]!)
    assert.equal(b.html, '<p>already markup</p>')
    assert.equal(b.text, 'already markup')
  })

  test('retries a 429 and then succeeds', async () => {
    // deliver() calls send() once. Without a retry here a transient rate limit
    // silently loses the one email saying a node is down.
    const { impl, calls } = stubFetch([{ status: 429 }, { status: 200 }])
    await new ResendEmailSender('k', 'f@x.dev', impl).send('a@b.co', 's', 'b')
    assert.equal(calls.length, 2)
  })

  test('does not retry a 422, because retrying cannot fix a bad address', async () => {
    const { impl, calls } = stubFetch([{ status: 422, body: '{"message":"invalid to field"}' }])
    await assert.rejects(
      () => new ResendEmailSender('k', 'f@x.dev', impl).send('nope', 's', 'b'),
      /422/
    )
    assert.equal(calls.length, 1, 'a 4xx that is not 408 or 429 is final')
  })

  test('puts the response body in the error, not just the status', async () => {
    // Resend explains itself in the body. "403" alone is useless when the real
    // problem is that the sending domain was never verified.
    const { impl } = stubFetch([{ status: 403, body: '{"message":"domain not verified"}' }])
    await assert.rejects(
      () => new ResendEmailSender('k', 'f@x.dev', impl).send('a@b.co', 's', 'b'),
      /domain not verified/
    )
  })

  test('rejects an empty recipient instead of posting it', async () => {
    const { impl, calls } = stubFetch([{ status: 200 }])
    await assert.rejects(
      () => new ResendEmailSender('k', 'f@x.dev', impl).send('', 's', 'b'),
      /no "to" address/
    )
    assert.equal(calls.length, 0)
  })
})

describe('createEmailSender', () => {
  test('returns a Resend sender when key and from are both set', () => {
    const s = createEmailSender(cfg({ RESEND_API_KEY: 'k', MAIL_FROM: 'f@x.dev' }))
    assert.ok(s instanceof ResendEmailSender)
  })

  test('falls back to logging when nothing is configured', () => {
    assert.ok(createEmailSender(cfg()) instanceof LoggingEmailSender)
  })

  test('warns and disables when only half configured', () => {
    // A from-address with no key is a setting that quietly does nothing, which
    // is worse than either being absent.
    const warns: string[] = []
    const log = { info: () => {}, warn: (_o: unknown, m: string) => warns.push(m) }
    const s = createEmailSender(cfg({ MAIL_FROM: 'f@x.dev' }), log)
    assert.ok(s instanceof LoggingEmailSender)
    assert.equal(warns.length, 1)
    assert.match(warns[0]!, /half-configured/)
  })

  test('never throws when unconfigured, so an unconfigured control plane still works', async () => {
    const warns: string[] = []
    const log = { info: () => {}, warn: (_o: unknown, m: string) => warns.push(m) }
    await new LoggingEmailSender(log).send('a@b.co', 's', 'b')
    assert.equal(warns.length, 1)
    assert.match(warns[0]!, /no RESEND_API_KEY/)
  })
})

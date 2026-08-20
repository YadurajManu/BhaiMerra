import 'dotenv/config'
import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { eq } from 'drizzle-orm'
import { createServer, type Server } from 'node:http'

import { loadConfig } from '../src/config.js'
import { createContext, closeContext, type AppContext } from '../src/api/context.js'
import { orgs, fleets, alertRules } from '../src/db/schema.js'
import { dispatchEvent, signPayload, verifySignature } from '../src/alerting/dispatch.js'
import { headline, severityOf, toDiscord, toSlack, toWebhook } from '../src/alerting/format.js'
import type { FleetEventPayload } from '../src/lib/events.js'

const nodeDown = (fleetId: string): FleetEventPayload => ({
  type: 'node.down',
  fleetId,
  at: new Date().toISOString(),
  subject: 'thinkpad',
  detail: { missedThreshold: 3, intervalSec: 5, silentForMs: 15000 },
})

const pinnedDown = (fleetId: string): FleetEventPayload => ({
  type: 'service.pinned_unavailable',
  fleetId,
  at: new Date().toISOString(),
  subject: 'postgres',
  detail: { nodeId: 'n3', why: 'Pinned services are never relocated automatically.' },
})

describe('alert formatting', () => {
  test('severity distinguishes a routine move from a pinned service being down', () => {
    // This distinction is the entire point of the alerting story (PRD 6.4).
    assert.equal(severityOf('service.rescheduled'), 'info')
    assert.equal(severityOf('service.pinned_unavailable'), 'critical')
    assert.equal(severityOf('node.down'), 'warning')
  })

  test('the headline says what happened and what was done about it', () => {
    assert.match(headline(nodeDown('f')), /thinkpad stopped responding after 3 missed heartbeats/)
    assert.match(headline(pinnedDown('f')), /DOWN and was not moved/)
  })

  test('a successful reschedule names the destination', () => {
    const moved: FleetEventPayload = {
      type: 'service.rescheduled',
      fleetId: 'f',
      at: new Date().toISOString(),
      subject: 'img-proxy',
      detail: { from: 'n3', to: 'home-server', score: 0.92 },
    }
    assert.match(headline(moved), /img-proxy moved to home-server automatically/)
  })

  test('a failed reschedule says why, rather than claiming success', () => {
    const stranded: FleetEventPayload = {
      type: 'service.rescheduled',
      fleetId: 'f',
      at: new Date().toISOString(),
      subject: 'whisper',
      detail: { failed: true, summary: 'No eligible node: 2 no gpu, 1 offline.' },
    }
    assert.match(headline(stranded), /could not be rescheduled/)
    assert.match(headline(stranded), /no gpu/)
  })

  test('discord and slack payloads carry the severity visually', () => {
    const critical = toDiscord(pinnedDown('f'))
    assert.equal(critical.embeds[0]!.color, 0xff5f52)
    const slack = toSlack(pinnedDown('f'))
    assert.match(slack.text, /:rotating_light:/)
  })

  test('the generic webhook payload is a stable contract', () => {
    const payload = toWebhook(nodeDown('fleet-1'))
    assert.deepEqual(Object.keys(payload).sort(), [
      'at', 'detail', 'fleet_id', 'message', 'severity', 'subject', 'type',
    ])
    assert.equal(payload.severity, 'warning')
  })
})

describe('webhook signing', () => {
  test('a receiver can verify the alert came from us', () => {
    const body = JSON.stringify({ hello: 'world' })
    const signature = signPayload(body, 'a-shared-secret-value')
    assert.ok(verifySignature(body, 'a-shared-secret-value', signature))
  })

  test('a tampered body fails verification', () => {
    const signature = signPayload('{"ok":true}', 'secret-value-here')
    assert.equal(verifySignature('{"ok":false}', 'secret-value-here', signature), false)
  })

  test('the wrong secret fails verification', () => {
    const body = '{"ok":true}'
    assert.equal(verifySignature(body, 'other-secret-value', signPayload(body, 'secret-value-here')), false)
  })
})

describe('delivery', () => {
  let ctx: AppContext
  let orgId: string
  let fleetId: string
  let server: Server
  let received: Array<{ body: string; headers: Record<string, string | string[] | undefined> }> = []
  let port = 0
  let respondWith = 200
  let failuresBeforeSuccess = 0

  before(async () => {
    ctx = createContext(loadConfig())
    const [org] = await ctx.db.insert(orgs).values({ name: 'alerting-test' }).returning()
    orgId = org!.id
    const [fleet] = await ctx.db.insert(fleets).values({ orgId, name: `alerting-${Date.now()}` }).returning()
    fleetId = fleet!.id

    server = createServer((req, res) => {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        if (failuresBeforeSuccess > 0) {
          failuresBeforeSuccess--
          res.writeHead(503).end()
          return
        }
        received.push({ body, headers: req.headers })
        res.writeHead(respondWith).end()
      })
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    port = (server.address() as { port: number }).port
  })

  after(async () => {
    await new Promise<void>((r) => server.close(() => r()))
    await ctx.db.delete(orgs).where(eq(orgs.id, orgId))
    await closeContext(ctx)
  })

  const addRule = (over: Partial<typeof alertRules.$inferInsert> = {}) =>
    ctx.db
      .insert(alertRules)
      .values({
        fleetId,
        channelType: 'webhook',
        channelConfig: { url: `http://127.0.0.1:${port}/hook` },
        eventTypes: [],
        ...over,
      })
      .returning()

  test('an event with no rules delivers nothing and does not throw', async () => {
    assert.deepEqual(await dispatchEvent(ctx, nodeDown(fleetId)), [])
  })

  test('a rule with no event types subscribes to everything', async () => {
    const [rule] = await addRule()
    received = []
    const results = await dispatchEvent(ctx, nodeDown(fleetId))
    assert.equal(results.length, 1)
    assert.equal(results[0]!.ok, true)
    assert.equal(received.length, 1)
    await ctx.db.delete(alertRules).where(eq(alertRules.id, rule!.id))
  })

  test('a rule only fires for the events it subscribed to', async () => {
    const [rule] = await addRule({ eventTypes: ['service.pinned_unavailable'] })
    received = []

    await dispatchEvent(ctx, nodeDown(fleetId))
    assert.equal(received.length, 0, 'node.down is not subscribed')

    await dispatchEvent(ctx, pinnedDown(fleetId))
    assert.equal(received.length, 1, 'the subscribed event is delivered')

    await ctx.db.delete(alertRules).where(eq(alertRules.id, rule!.id))
  })

  test('the payload is signed when the rule carries a secret', async () => {
    const secret = 'a-sufficiently-long-secret'
    const [rule] = await addRule({ channelConfig: { url: `http://127.0.0.1:${port}/hook`, secret } })
    received = []

    await dispatchEvent(ctx, nodeDown(fleetId))
    const delivery = received[0]!
    const signature = String(delivery.headers['x-fleet-signature'])
    assert.ok(verifySignature(delivery.body, secret, signature), 'signature must verify')
    assert.equal(delivery.headers['x-fleet-severity'], 'warning')

    await ctx.db.delete(alertRules).where(eq(alertRules.id, rule!.id))
  })

  test('a disabled rule is skipped', async () => {
    const [rule] = await addRule({ enabled: false })
    received = []
    assert.deepEqual(await dispatchEvent(ctx, nodeDown(fleetId)), [])
    await ctx.db.delete(alertRules).where(eq(alertRules.id, rule!.id))
  })

  test('a 5xx is retried and can still succeed', async () => {
    const [rule] = await addRule()
    received = []
    failuresBeforeSuccess = 2

    const results = await dispatchEvent(ctx, nodeDown(fleetId))
    assert.equal(results[0]!.ok, true)
    assert.equal(results[0]!.attempts, 3, 'two failures then a success')
    assert.equal(received.length, 1)

    await ctx.db.delete(alertRules).where(eq(alertRules.id, rule!.id))
  })

  test('a 4xx is not retried — a bad URL stays bad', async () => {
    const [rule] = await addRule()
    received = []
    respondWith = 404

    const results = await dispatchEvent(ctx, nodeDown(fleetId))
    assert.equal(results[0]!.ok, false)
    assert.equal(results[0]!.attempts, 1, 'no point retrying a rejection')

    respondWith = 200
    await ctx.db.delete(alertRules).where(eq(alertRules.id, rule!.id))
  })

  test('one dead channel does not stop the others', async () => {
    // The whole reason delivery never throws: an unreachable Discord webhook
    // must not stop the sweeper, or the other alerts for the same event.
    const [dead] = await addRule({ channelConfig: { url: 'http://127.0.0.1:1/nothing-here' } })
    const [alive] = await addRule()
    received = []

    const results = await dispatchEvent(ctx, nodeDown(fleetId))
    assert.equal(results.length, 2)
    assert.equal(results.filter((r) => r.ok).length, 1)
    assert.equal(results.filter((r) => !r.ok).length, 1)
    assert.equal(received.length, 1, 'the healthy channel still got it')

    await ctx.db.delete(alertRules).where(eq(alertRules.id, dead!.id))
    await ctx.db.delete(alertRules).where(eq(alertRules.id, alive!.id))
  })
})

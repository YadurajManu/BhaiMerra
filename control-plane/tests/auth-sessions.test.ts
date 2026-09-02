/**
 * Recognising a sign-in as new.
 *
 * Most of these tests are about what must NOT send an email. Detection is
 * easy; restraint is the hard part, and an alert that fires on every login is
 * one people learn to delete unread.
 */
import 'dotenv/config'
import { test, describe, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { eq } from 'drizzle-orm'

import { loadConfig } from '../src/config.js'
import { createContext, closeContext, type AppContext } from '../src/api/context.js'
import { users, authSessions } from '../src/db/schema.js'
import {
  parseDevice,
  deviceHash,
  describeDevice,
  loginContextFrom,
  recordSignIn,
  listDevices,
  forgetDevice,
} from '../src/auth/sessions.js'
import { newSignInEmail, countryName } from '../src/email/templates.js'

const CHROME_MAC =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const CHROME_MAC_NEWER =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36'
const SAFARI_IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'

let ctx: AppContext
let userId: string

before(async () => {
  ctx = createContext(loadConfig())
  const [u] = await ctx.db
    .insert(users)
    .values({ email: `sess-${Date.now()}@example.test`, passwordHash: 'x' })
    .returning()
  userId = u!.id
})

beforeEach(async () => {
  await ctx.db.delete(authSessions).where(eq(authSessions.userId, userId))
})

after(async () => {
  await ctx.db.delete(authSessions).where(eq(authSessions.userId, userId))
  await ctx.db.delete(users).where(eq(users.id, userId))
  await closeContext(ctx)
})

describe('device fingerprint', () => {
  test('identifies browser and OS family', () => {
    assert.deepEqual(parseDevice(CHROME_MAC), { browser: 'Chrome', os: 'macOS' })
    assert.deepEqual(parseDevice(SAFARI_IPHONE), { browser: 'Safari', os: 'iOS' })
    assert.equal(describeDevice(parseDevice(CHROME_MAC)), 'Chrome on macOS')
  })

  test('a browser version bump is the same device', () => {
    // Chrome ships a major version every few weeks. If that read as a new
    // device, the alert would fire monthly for everyone and mean nothing.
    assert.equal(deviceHash(parseDevice(CHROME_MAC)), deviceHash(parseDevice(CHROME_MAC_NEWER)))
  })

  test('a different browser or OS is a different device', () => {
    assert.notEqual(deviceHash(parseDevice(CHROME_MAC)), deviceHash(parseDevice(SAFARI_IPHONE)))
  })

  test('an absent user agent still produces a stable hash', () => {
    assert.equal(deviceHash(parseDevice(null)), deviceHash(parseDevice('')))
  })
})

describe('login context from edge headers', () => {
  test('prefers cf-connecting-ip and reads the country', () => {
    const c = loginContextFrom(
      { 'cf-connecting-ip': '203.0.113.9', 'cf-ipcountry': 'IN', 'user-agent': CHROME_MAC },
      '10.0.0.1'
    )
    assert.equal(c.ip, '203.0.113.9')
    assert.equal(c.country, 'IN')
  })

  test('falls back to the request ip when the edge header is absent', () => {
    const c = loginContextFrom({ 'user-agent': CHROME_MAC }, '198.51.100.4')
    assert.equal(c.ip, '198.51.100.4')
    assert.equal(c.country, null)
  })

  test('treats XX as unknown rather than as a country', () => {
    // Cloudflare sends XX when it cannot determine one. Rendering "XX" as a
    // location in a security email would be worse than saying unknown.
    assert.equal(loginContextFrom({ 'cf-ipcountry': 'XX' }).country, null)
  })
})

describe('new sign-in detection', () => {
  const ctxFor = (ua: string, country: string | null, ip = '203.0.113.1') => ({
    ip,
    userAgent: ua,
    country,
  })

  test('the very first sign-in does not alert', async () => {
    // It is the person who just created the account. Mailing them about it is
    // noise on top of the verification email they already received.
    const v = await recordSignIn(ctx, userId, ctxFor(CHROME_MAC, 'IN'))
    assert.equal(v.isNew, false)
    assert.equal(v.reason, 'first_device')
  })

  test('the same device signing in again does not alert', async () => {
    await recordSignIn(ctx, userId, ctxFor(CHROME_MAC, 'IN'))
    const v = await recordSignIn(ctx, userId, ctxFor(CHROME_MAC_NEWER, 'IN'))
    assert.equal(v.isNew, false)
    assert.equal(v.reason, 'known')
  })

  test('a new IP in a known country does not alert', async () => {
    // Mobile networks rotate addresses constantly. This project's own operator
    // changed public IP three times in one afternoon.
    await recordSignIn(ctx, userId, ctxFor(CHROME_MAC, 'IN', '203.0.113.1'))
    const v = await recordSignIn(ctx, userId, ctxFor(CHROME_MAC, 'IN', '198.51.100.77'))
    assert.equal(v.isNew, false)
  })

  test('an unseen device alerts', async () => {
    await recordSignIn(ctx, userId, ctxFor(CHROME_MAC, 'IN'))
    const v = await recordSignIn(ctx, userId, ctxFor(SAFARI_IPHONE, 'IN'))
    assert.equal(v.isNew, true)
    assert.equal(v.reason, 'first_device')
  })

  test('a known device from a new country alerts', async () => {
    await recordSignIn(ctx, userId, ctxFor(CHROME_MAC, 'IN'))
    const v = await recordSignIn(ctx, userId, ctxFor(CHROME_MAC, 'DE'))
    assert.equal(v.isNew, true)
    assert.equal(v.reason, 'new_country')
  })

  test('counts logins per device instead of adding rows', async () => {
    await recordSignIn(ctx, userId, ctxFor(CHROME_MAC, 'IN'))
    await recordSignIn(ctx, userId, ctxFor(CHROME_MAC, 'IN'))
    await recordSignIn(ctx, userId, ctxFor(CHROME_MAC, 'IN'))
    const devices = await listDevices(ctx, userId)
    assert.equal(devices.length, 1)
    assert.equal(devices[0]!.loginCount, 3)
  })

  test('forgetting a device makes the next sign-in alert again', async () => {
    await recordSignIn(ctx, userId, ctxFor(CHROME_MAC, 'IN'))
    await recordSignIn(ctx, userId, ctxFor(SAFARI_IPHONE, 'IN'))

    assert.equal(await forgetDevice(ctx, userId, deviceHash(parseDevice(SAFARI_IPHONE))), true)
    const v = await recordSignIn(ctx, userId, ctxFor(SAFARI_IPHONE, 'IN'))
    assert.equal(v.isNew, true)
  })

  test('a missing country never counts as a new country', async () => {
    // Otherwise every sign-in from a network the edge cannot geolocate would
    // alert, which is the noise failure again.
    await recordSignIn(ctx, userId, ctxFor(CHROME_MAC, 'IN'))
    const v = await recordSignIn(ctx, userId, ctxFor(CHROME_MAC, null))
    assert.equal(v.isNew, false)
  })
})

describe('the sign-in email', () => {
  const mail = () =>
    newSignInEmail({
      device: 'Chrome on macOS',
      ip: '203.0.113.9',
      country: 'DE',
      at: new Date('2026-09-02T10:30:00Z'),
      reason: 'new_country',
      dashboardUrl: 'https://app.example.com',
    })

  test('contains no link and no button', () => {
    // A security notice with a "secure your account" button is
    // indistinguishable from the phishing email that copies it.
    const { body } = mail()
    assert.ok(!body.includes('<a '), 'no anchor tags')
    assert.ok(!/href=/.test(body), 'no href attributes')
  })

  test('states the facts a person needs to judge it', () => {
    const { body, subject } = mail()
    assert.match(subject, /New sign-in from Germany/)
    assert.ok(body.includes('Chrome on macOS'))
    assert.ok(body.includes('203.0.113.9'))
    assert.ok(body.includes('Germany'))
    assert.ok(body.includes('2026-09-02 10:30:00'))
  })

  test('says the location is unknown rather than printing a code', () => {
    assert.equal(countryName(null), 'Unknown location')
    const { body } = newSignInEmail({
      device: 'Firefox on Linux', ip: null, country: null,
      at: new Date(), reason: 'first_device',
    })
    assert.ok(body.includes('Could not be determined'))
    assert.ok(body.includes('Not recorded'))
  })
})

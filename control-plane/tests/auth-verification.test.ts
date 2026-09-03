/**
 * What a signed-in but unconfirmed account is told.
 *
 * Two behaviours here look inconsistent and are deliberately not. A signup
 * succeeds even when no mail can be sent, because nobody should be unable to
 * create an account while a mail provider is having a bad day. An explicit
 * "send it again" fails loudly in the same situation, because reporting
 * success you did not achieve sends someone to search an inbox that will never
 * receive anything.
 *
 * This is not hypothetical. A sending domain that Resend had not verified was
 * rejected with a 403 on every attempt, the endpoint answered 200 regardless,
 * and the screen said the mail was on its way. The only evidence was a warning
 * in a container log.
 */
import 'dotenv/config'
import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import type { FastifyInstance } from 'fastify'

import { loadConfig } from '../src/config.js'
import { createContext, closeContext, type AppContext } from '../src/api/context.js'
import { buildServer } from '../src/server.js'

/** Stands in for a provider that rejects everything, the way an unverified
    sending domain does. */
function brokenEmail(ctx: AppContext) {
  ctx.email = {
    send: async () => {
      throw new Error('resend: 403 {"message":"The example.test domain is not verified"}')
    },
  } as AppContext['email']
}

describe('an unconfirmed address', () => {
  let ctx: AppContext
  let app: FastifyInstance
  let accessToken: string

  before(async () => {
    ctx = createContext(loadConfig())
    brokenEmail(ctx)
    app = await buildServer(ctx)

    const signup = await app.inject({
      method: 'POST',
      url: '/auth/signup',
      payload: {
        email: `verify-${Date.now()}@example.test`,
        password: 'a-long-enough-password',
      },
    })
    // The asymmetry, asserted rather than described: the mail failed and the
    // account exists anyway.
    assert.equal(signup.statusCode, 201, 'signup must survive a dead mail provider')
    accessToken = signup.json().accessToken
  })

  after(async () => {
    await app?.close()
    await closeContext(ctx)
  })

  test('/auth/me reports the address as unconfirmed', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: { authorization: `Bearer ${accessToken}` },
    })
    assert.equal(res.statusCode, 200)
    const body = res.json()
    // Present and null, not absent. The dashboard gates on this field, and a
    // missing key is indistinguishable from a confirmed account to anything
    // reading it with `!= null`.
    assert.ok('emailVerifiedAt' in body.user, 'emailVerifiedAt must be present')
    assert.equal(body.user.emailVerifiedAt, null)
  })

  test('resending says it failed rather than claiming success', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/resend-verification',
      headers: { authorization: `Bearer ${accessToken}` },
    })
    assert.equal(res.statusCode, 503, 'a send that did not happen is not a 200')
    assert.equal(res.json().error?.code ?? res.json().code, 'email_send_failed')
  })

  test('a rejected send does not spend the hourly allowance', async () => {
    // Ten failures in a row. If a failed attempt counted, the eleventh - and
    // in the original three-per-hour version, the fourth - would come back as
    // "too many requests", which is a second error unrelated to the real one
    // and locks someone out of their own account for an hour over mail that
    // was never sent.
    for (let i = 0; i < 10; i++) {
      const res = await app.inject({
        method: 'POST',
        url: '/auth/resend-verification',
        headers: { authorization: `Bearer ${accessToken}` },
      })
      assert.equal(res.statusCode, 503, `attempt ${i + 1} should report the send failure`)
    }
  })

  test('the failure message does not blame the reader', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/resend-verification',
      headers: { authorization: `Bearer ${accessToken}` },
    })
    const message = String(res.json().error?.message ?? res.json().message ?? '')
    // Nothing the reader can do differently caused this, so the copy must not
    // send them to check their own address or their spam folder.
    assert.match(message, /our side/i)
  })
})

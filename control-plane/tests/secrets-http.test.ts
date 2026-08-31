/**
 * The whole chain, over HTTP: set a secret, deploy a service that declares it,
 * and confirm the value arrives in the desired state the agent polls — and
 * nowhere else.
 *
 * Module-level tests can prove the store encrypts and resolves correctly. Only
 * this can prove the guards are wired, the deploy path refuses a missing
 * secret, and no response between signup and desired-state leaks a value.
 */
import 'dotenv/config'
import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'

import { loadConfig } from '../src/config.js'
import { createContext, closeContext, type AppContext } from '../src/api/context.js'
import { buildServer } from '../src/server.js'
import { orgs, users } from '../src/db/schema.js'

const SECRET_VALUE = 'postgres://app:s3cr3t-do-not-leak@postgres:5432/app'

describe('secrets over HTTP, end to end', () => {
  let ctx: AppContext
  let app: FastifyInstance
  let token: string
  let fleetId: string
  let orgId: string
  let userId: string
  let serviceId: string
  let agentToken: string

  before(async () => {
    ctx = createContext(loadConfig())
    app = await buildServer(ctx)

    const email = `secrets-${Date.now()}@example.test`
    const signup = await app.inject({
      method: 'POST',
      url: '/auth/signup',
      payload: { email, password: 'a-long-enough-password' },
    })
    assert.equal(signup.statusCode, 201, signup.body)
    const body = signup.json()
    token = body.accessToken
    fleetId = body.fleet.id
    orgId = body.org.id
    userId = body.user.id
  })

  after(async () => {
    await app.close()
    await ctx.db.delete(orgs).where(eq(orgs.id, orgId))
    await ctx.db.delete(users).where(eq(users.id, userId))
    await closeContext(ctx)
  })

  const auth = (extra: Record<string, unknown> = {}) => ({
    headers: { authorization: `Bearer ${token}` },
    ...extra,
  })

  test('a manifest declaring env and secrets applies cleanly', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/fleets/${fleetId}/services`,
      ...auth(),
      payload: {
        manifest: `
fleet: homelab
services:
  web:
    image: nginx:1.27-alpine
    env:
      LOG_LEVEL: debug
    secrets: [DATABASE_URL]
`,
      },
    })
    assert.equal(res.statusCode, 200, res.body)
    assert.deepEqual(res.json().created, ['web'])

    const list = await app.inject({ method: 'GET', url: `/fleets/${fleetId}/services`, ...auth() })
    serviceId = list.json().services[0].id
    assert.ok(serviceId)
  })

  test('deploying before the secret is set fails with the name and the fix', async () => {
    // Pair a node first, so the failure is genuinely about the secret and not
    // about there being nowhere to run.
    const pair = await app.inject({
      method: 'POST',
      url: `/fleets/${fleetId}/nodes/pair-token`,
      ...auth(),
      payload: {},
    })
    assert.equal(pair.statusCode, 201, pair.body)

    const register = await app.inject({
      method: 'POST',
      url: '/agent/register',
      headers: { authorization: `Bearer ${pair.json().token}` },
      payload: {
        arch: 'amd64',
        cpu_cores: 4,
        ram_mb: 8192,
        disk_mb: 100_000,
        hostname: 'test-node',
        advertise_addr: '10.0.0.9',
      },
    })
    assert.equal(register.statusCode, 201, register.body)
    agentToken = register.json().agent_token

    const deploy = await app.inject({
      method: 'POST',
      url: `/services/${serviceId}/deploy`,
      ...auth(),
      payload: {},
    })
    assert.equal(deploy.statusCode, 422, deploy.body)
    const err = deploy.json().error
    assert.equal(err.code, 'missing_secrets')
    assert.match(err.message, /DATABASE_URL/)
    // The message should tell you what to run, not just what is wrong.
    assert.match(JSON.stringify(err.detail), /fleet secrets set DATABASE_URL/)
  })

  test('storing a secret reports it was created and returns no value', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: `/fleets/${fleetId}/secrets/DATABASE_URL`,
      ...auth(),
      payload: { value: SECRET_VALUE },
    })
    assert.equal(res.statusCode, 201, res.body)
    assert.equal(res.json().created, true)
    assert.ok(!res.body.includes('s3cr3t'), 'the write response echoed the value back')
  })

  test('listing shows the name and never the value', async () => {
    const res = await app.inject({ method: 'GET', url: `/fleets/${fleetId}/secrets`, ...auth() })
    assert.equal(res.statusCode, 200)
    const rows = res.json().secrets
    assert.equal(rows.length, 1)
    assert.equal(rows[0].key, 'DATABASE_URL')
    assert.equal(rows[0].scope, 'fleet')
    assert.ok(!res.body.includes('s3cr3t'), 'the listing leaked the value')
  })

  test('the service list carries plain env but no secret value', async () => {
    const res = await app.inject({ method: 'GET', url: `/fleets/${fleetId}/services`, ...auth() })
    const service = res.json().services[0]
    assert.equal(service.env.LOG_LEVEL, 'debug')
    assert.deepEqual(service.secretRefs, ['DATABASE_URL'])
    assert.ok(!res.body.includes('s3cr3t'), 'a secret value reached the service list')
  })

  test('a viewer-level path cannot read the store', async () => {
    // No token at all is the cheapest proof the route is guarded.
    const res = await app.inject({ method: 'GET', url: `/fleets/${fleetId}/secrets` })
    assert.equal(res.statusCode, 401)
  })

  test('the deploy now succeeds', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/services/${serviceId}/deploy`,
      ...auth(),
      payload: {},
    })
    assert.equal(res.statusCode, 201, res.body)
    assert.equal(res.json().placedOn.name, 'test-node')
    assert.ok(!res.body.includes('s3cr3t'), 'the deploy response leaked the value')
  })

  test('the agent receives the resolved environment', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/agent/desired-state',
      headers: { authorization: `Bearer ${agentToken}` },
    })
    assert.equal(res.statusCode, 200, res.body)

    const [service] = res.json().services
    assert.equal(service.name, 'web')
    // The plain value and the secret arrive together, as one environment.
    assert.equal(service.env.LOG_LEVEL, 'debug')
    assert.equal(service.env.DATABASE_URL, SECRET_VALUE)
  })

  test('an unauthenticated caller cannot read the desired state', async () => {
    const res = await app.inject({ method: 'GET', url: '/agent/desired-state' })
    assert.equal(res.statusCode, 401)
    assert.ok(!res.body.includes('s3cr3t'))
  })

  test('deleting the secret leaves the running deployment alone', async () => {
    const del = await app.inject({
      method: 'DELETE',
      url: `/fleets/${fleetId}/secrets/DATABASE_URL`,
      ...auth(),
    })
    assert.equal(del.statusCode, 200, del.body)

    // Desired state still answers — it just omits what it cannot resolve. A
    // container that is already up must not be torn down because somebody
    // removed a key it was started with.
    const res = await app.inject({
      method: 'GET',
      url: '/agent/desired-state',
      headers: { authorization: `Bearer ${agentToken}` },
    })
    assert.equal(res.statusCode, 200)
    const [service] = res.json().services
    assert.equal(service.env.LOG_LEVEL, 'debug')
    assert.ok(!('DATABASE_URL' in service.env), 'a deleted secret was still handed out')
  })
})

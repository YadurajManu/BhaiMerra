/**
 * Volume paths, resource limits and health checks.
 *
 * Each of these was declared somewhere and applied nowhere: `volume` mounted
 * at a fixed /data, `resources.ram` filtered placement and then capped nothing,
 * and `health:` reached the agent's RunSpec and stopped there. The tests worth
 * having are the ones that would fail again if any of them went back to being
 * carried but not used, so they follow the value all the way to the payload the
 * agent actually reads.
 */
import 'dotenv/config'
import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'

import { loadConfig } from '../src/config.js'
import { createContext, closeContext, type AppContext } from '../src/api/context.js'
import { buildServer } from '../src/server.js'
import { orgs, users, services } from '../src/db/schema.js'
import { parseManifest, parseDurationSec } from '../src/manifest/parse.js'

describe('duration parsing', () => {
  test('understands the units the spec documents', () => {
    assert.equal(parseDurationSec('5s'), 5)
    assert.equal(parseDurationSec('1m'), 60)
    assert.equal(parseDurationSec('2h'), 7200)
    assert.equal(parseDurationSec('1500ms'), 2)
  })

  test('a bare number means seconds', () => {
    assert.equal(parseDurationSec(30), 30)
    assert.equal(parseDurationSec('30'), 30)
  })

  test('rounds up, because a timeout that becomes zero means no timeout', () => {
    // Docker reads 0 as "unset", so rounding 500ms down would silently turn a
    // tight timeout into none at all.
    assert.equal(parseDurationSec('500ms'), 1)
    assert.equal(parseDurationSec('1ms'), 1)
  })

  test('rejects nonsense rather than guessing', () => {
    assert.equal(parseDurationSec('soon'), null)
    assert.equal(parseDurationSec('0s'), null)
    assert.equal(parseDurationSec('-5s'), null)
    assert.equal(parseDurationSec(''), null)
  })
})

describe('volume declarations', () => {
  const parse = (body: string) =>
    parseManifest(`fleet: homelab\nservices:\n  db:\n    image: postgres:16\n${body}`)

  test('the string form still works and mounts at the default', () => {
    const svc = parse('    volume: pgdata\n').services[0]!
    assert.equal(svc.volume, 'pgdata')
    assert.equal(svc.volumePath, undefined)
  })

  test('the object form carries the path the image actually uses', () => {
    const svc = parse('    volume: { name: pgdata, path: /var/lib/postgresql/data }\n').services[0]!
    assert.equal(svc.volume, 'pgdata')
    assert.equal(svc.volumePath, '/var/lib/postgresql/data')
  })

  test('a relative mount path is refused, naming the rule', () => {
    assert.throws(
      () => parse('    volume: { name: pgdata, path: var/lib/postgres }\n'),
      (err: Error) => /absolute path/.test(err.message)
    )
  })

  test('a volume on a flexible service still warns about data not moving', () => {
    const parsed = parseManifest(`
fleet: homelab
services:
  db:
    image: postgres:16
    placement: flexible
    volume: { name: pgdata, path: /var/lib/postgresql/data }
`)
    assert.match(parsed.warnings.join('\n'), /Volumes do not move between machines/)
  })
})

describe('health declarations', () => {
  const parse = (body: string) =>
    parseManifest(`fleet: homelab\nservices:\n  web:\n    image: nginx\n${body}`)

  test('timings are parsed into seconds, not carried as strings', () => {
    const svc = parse('    health: { path: /healthz, interval: 30s, timeout: 2s }\n').services[0]!
    assert.equal(svc.health.path, '/healthz')
    assert.equal(svc.health.interval, 30)
    assert.equal(svc.health.timeout, 2)
  })

  test('the documented defaults apply when omitted', () => {
    const svc = parse('    placement: flexible\n').services[0]!
    assert.equal(svc.health.path, '/')
    assert.equal(svc.health.interval, 15)
    assert.equal(svc.health.timeout, 5)
    assert.equal(svc.health.disabled, false)
  })

  test('an image with no shell can opt out', () => {
    const svc = parse('    health: { disabled: true }\n').services[0]!
    assert.equal(svc.health.disabled, true)
  })

  test('a bad duration names the accepted forms', () => {
    assert.throws(
      () => parse('    health: { interval: soon }\n'),
      (err: Error) => /5s, 500ms, 1m/.test(err.message)
    )
  })
})

describe('what the agent is actually told', () => {
  let ctx: AppContext
  let app: FastifyInstance
  let token: string
  let fleetId: string
  let orgId: string
  let userId: string
  let agentToken: string

  before(async () => {
    ctx = createContext(loadConfig())
    app = await buildServer(ctx)

    const signup = await app.inject({
      method: 'POST',
      url: '/auth/signup',
      payload: { email: `stateful-${Date.now()}@example.test`, password: 'a-long-enough-password' },
    })
    const body = signup.json()
    token = body.accessToken
    fleetId = body.fleet.id
    orgId = body.org.id
    userId = body.user.id

    const pair = await app.inject({
      method: 'POST',
      url: `/fleets/${fleetId}/nodes/pair-token`,
      headers: { authorization: `Bearer ${token}` },
      payload: {},
    })
    const register = await app.inject({
      method: 'POST',
      url: '/agent/register',
      headers: { authorization: `Bearer ${pair.json().token}` },
      payload: {
        arch: 'amd64',
        cpu_cores: 4,
        ram_mb: 8192,
        disk_mb: 100_000,
        hostname: 'db-node',
        advertise_addr: '10.0.0.12',
      },
    })
    agentToken = register.json().agent_token

    await app.inject({
      method: 'POST',
      url: `/fleets/${fleetId}/services`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        manifest: `
fleet: homelab
services:
  postgres:
    image: postgres:16-alpine
    internal: true
    placement: pinned
    node: db-node
    volume: { name: pgdata, path: /var/lib/postgresql/data }
    resources: { ram: 512Mi }
    health: { path: /healthz, interval: 30s, timeout: 2s }
`,
      },
    })

    const [svc] = await ctx.db.select().from(services).where(eq(services.fleetId, fleetId))
    await app.inject({
      method: 'POST',
      url: `/services/${svc!.id}/deploy`,
      headers: { authorization: `Bearer ${token}` },
      payload: {},
    })
  })

  after(async () => {
    await app.close()
    await ctx.db.delete(orgs).where(eq(orgs.id, orgId))
    await ctx.db.delete(users).where(eq(users.id, userId))
    await closeContext(ctx)
  })

  test('the mount path reaches the node, not just the database row', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/agent/desired-state',
      headers: { authorization: `Bearer ${agentToken}` },
    })
    const [svc] = res.json().services
    assert.equal(svc.volume, 'pgdata')
    // The whole point: without this, Postgres writes to its own image layer and
    // the volume sits mounted at /data holding nothing.
    assert.equal(svc.volume_path, '/var/lib/postgresql/data')
  })

  test('the reserved memory is sent so the node can enforce it', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/agent/desired-state',
      headers: { authorization: `Bearer ${agentToken}` },
    })
    const [svc] = res.json().services
    assert.equal(svc.memory_mb, 512)
  })

  test('the health check timings travel with it', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/agent/desired-state',
      headers: { authorization: `Bearer ${agentToken}` },
    })
    const [svc] = res.json().services
    assert.equal(svc.health_check_path, '/healthz')
    assert.equal(svc.health_interval_sec, 30)
    assert.equal(svc.health_timeout_sec, 2)
    assert.equal(svc.health_disabled, false)
  })

  test('an internal service is still sent no port to publish', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/agent/desired-state',
      headers: { authorization: `Bearer ${agentToken}` },
    })
    const [svc] = res.json().services
    assert.equal(svc.host_port, null)
  })
})

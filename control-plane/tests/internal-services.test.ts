/**
 * Internal services — reachable by their neighbours, by nobody else.
 *
 * The behaviour being pinned down here is mostly about what does *not* happen:
 * no host port, no managed hostname, no ingress route. Each of those was
 * unconditional before, which meant deploying a database published it on the
 * node's interface for the whole network to find.
 */
import 'dotenv/config'
import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'

import { loadConfig } from '../src/config.js'
import { createContext, closeContext, type AppContext } from '../src/api/context.js'
import { buildServer } from '../src/server.js'
import { orgs, users, services, deployments } from '../src/db/schema.js'
import { parseManifest } from '../src/manifest/parse.js'
import { resolveRoute } from '../src/ingress/routes.js'

const MANIFEST = `
fleet: homelab
services:
  postgres:
    image: postgres:16-alpine
    internal: true
    env:
      POSTGRES_USER: app
  web:
    image: nginx:1.27-alpine
    affinity: [postgres]
    env:
      DATABASE_HOST: postgres
`

describe('internal services', () => {
  let ctx: AppContext
  let app: FastifyInstance
  let token: string
  let fleetId: string
  let orgId: string
  let userId: string

  before(async () => {
    ctx = createContext(loadConfig())
    app = await buildServer(ctx)

    const signup = await app.inject({
      method: 'POST',
      url: '/auth/signup',
      payload: { email: `internal-${Date.now()}@example.test`, password: 'a-long-enough-password' },
    })
    const body = signup.json()
    token = body.accessToken
    fleetId = body.fleet.id
    orgId = body.org.id
    userId = body.user.id

    // A node to place on.
    const pair = await app.inject({
      method: 'POST',
      url: `/fleets/${fleetId}/nodes/pair-token`,
      headers: { authorization: `Bearer ${token}` },
      payload: {},
    })
    await app.inject({
      method: 'POST',
      url: '/agent/register',
      headers: { authorization: `Bearer ${pair.json().token}` },
      payload: {
        arch: 'amd64',
        cpu_cores: 4,
        ram_mb: 8192,
        disk_mb: 100_000,
        hostname: 'stack-node',
        advertise_addr: '10.0.0.11',
      },
    })

    await app.inject({
      method: 'POST',
      url: `/fleets/${fleetId}/services`,
      headers: { authorization: `Bearer ${token}` },
      payload: { manifest: MANIFEST },
    })
  })

  after(async () => {
    await app.close()
    await ctx.db.delete(orgs).where(eq(orgs.id, orgId))
    await ctx.db.delete(users).where(eq(users.id, userId))
    await closeContext(ctx)
  })

  const load = async (name: string) => {
    const [row] = await ctx.db
      .select()
      .from(services)
      .where(eq(services.fleetId, fleetId))
      .then((rows) => rows.filter((r) => r.name === name))
    return row!
  }

  test('an internal service gets no managed hostname', async () => {
    const postgres = await load('postgres')
    assert.equal(postgres.internal, true)
    assert.equal(postgres.hostname, null, 'an internal service was given a public name')
  })

  test('a public service still gets one', async () => {
    const web = await load('web')
    assert.equal(web.internal, false)
    assert.ok(web.hostname, 'a public service lost its managed hostname')
  })

  test('deploying an internal service publishes no host port', async () => {
    const postgres = await load('postgres')
    const res = await app.inject({
      method: 'POST',
      url: `/services/${postgres.id}/deploy`,
      headers: { authorization: `Bearer ${token}` },
      payload: {},
    })
    assert.equal(res.statusCode, 201, res.body)

    const body = res.json()
    assert.equal(body.url, null, 'an internal service was handed a public URL')
    // It still has to say how it *is* reached, or the feature is just a denial.
    assert.equal(body.reachableAs, 'postgres:8080')

    const [row] = await ctx.db
      .select({ hostPort: deployments.hostPort })
      .from(deployments)
      .where(eq(deployments.serviceId, postgres.id))
    assert.equal(row!.hostPort, null, 'an internal service bound a port on the node')
  })

  test('a public service still gets a port to be reached on', async () => {
    const web = await load('web')
    const res = await app.inject({
      method: 'POST',
      url: `/services/${web.id}/deploy`,
      headers: { authorization: `Bearer ${token}` },
      payload: {},
    })
    assert.equal(res.statusCode, 201, res.body)
    assert.ok(res.json().url?.startsWith('https://'))

    const [row] = await ctx.db
      .select({ hostPort: deployments.hostPort })
      .from(deployments)
      .where(eq(deployments.serviceId, web.id))
    assert.ok(row!.hostPort && row!.hostPort >= 31000, 'a public service got no host port')
  })

  test('ingress cannot route to an internal service', async () => {
    // Nothing should resolve to it — it has no hostname to look up, and no
    // port to send anything to even if it did.
    const postgres = await load('postgres')
    assert.equal(postgres.hostname, null)
    assert.equal(await resolveRoute(ctx, 'postgres.fleetos.app'), null)
  })

  test('the agent is told to run it, without a port', async () => {
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
      payload: { arch: 'amd64', cpu_cores: 2, ram_mb: 2048, disk_mb: 20_000, hostname: 'reader' },
    })

    // Deployments are on the first node, so this second agent sees nothing —
    // which is itself the point: desired state is scoped per node.
    const res = await app.inject({
      method: 'GET',
      url: '/agent/desired-state',
      headers: { authorization: `Bearer ${register.json().agent_token}` },
    })
    assert.equal(res.statusCode, 200)
    assert.deepEqual(res.json().services, [])
  })
})

describe('manifest rules for internal services and discovery', () => {
  test('internal and domain together is a contradiction, not a precedence rule', () => {
    assert.throws(
      () =>
        parseManifest(`
fleet: homelab
services:
  db:
    image: postgres:16
    internal: true
    domain: db.example.com
`),
      (err: Error) => /contradict each other/.test(err.message)
    )
  })

  test('an env value naming another service without affinity is warned about', () => {
    // Names resolve per node. Without affinity the scheduler may split them,
    // and the failure would surface at runtime rather than here.
    const parsed = parseManifest(`
fleet: homelab
services:
  postgres:
    image: postgres:16
    internal: true
  web:
    image: nginx
    env:
      DATABASE_HOST: postgres
`)
    assert.equal(parsed.warnings.length, 1)
    assert.match(parsed.warnings[0]!, /affinity: \[postgres\]/)
  })

  test('declaring the affinity silences the warning', () => {
    const parsed = parseManifest(`
fleet: homelab
services:
  postgres:
    image: postgres:16
    internal: true
  web:
    image: nginx
    affinity: [postgres]
    env:
      DATABASE_HOST: postgres
`)
    assert.deepEqual(parsed.warnings, [])
  })

  test('an env value that merely looks like a word is not a dependency', () => {
    const parsed = parseManifest(`
fleet: homelab
services:
  web:
    image: nginx
    env:
      LOG_LEVEL: debug
      GREETING: hello
`)
    assert.deepEqual(parsed.warnings, [])
  })

  test('a username that happens to match a service name is not a dependency', () => {
    // DB_USER: postgres is a login, not a hostname. Warning about it is how a
    // warning system trains people to scroll past warnings.
    const parsed = parseManifest(`
fleet: homelab
services:
  postgres:
    image: postgres:16
    internal: true
  web:
    image: nginx
    env:
      DB_USER: postgres
`)
    assert.deepEqual(parsed.warnings, [])
  })

  test('services pinned to the same node cannot be split, so there is nothing to warn about', () => {
    const parsed = parseManifest(`
fleet: homelab
services:
  postgres:
    image: postgres:16
    internal: true
    placement: pinned
    node: node-a
  web:
    image: nginx
    placement: pinned
    node: node-a
    env:
      DB_HOST: postgres
`)
    assert.deepEqual(parsed.warnings, [])
  })

  test('but pinning them to different nodes is exactly the case worth warning about', () => {
    const parsed = parseManifest(`
fleet: homelab
services:
  postgres:
    image: postgres:16
    internal: true
    placement: pinned
    node: node-a
  web:
    image: nginx
    placement: pinned
    node: node-b
    env:
      DB_HOST: postgres
`)
    assert.equal(parsed.warnings.length, 1)
    assert.match(parsed.warnings[0]!, /DB_HOST/)
  })
})

describe('projects', () => {
  test('a manifest can name itself', () => {
    const parsed = parseManifest(`
fleet: homelab
project: muhdikhai
services:
  web: { image: nginx }
`)
    assert.equal(parsed.project, 'muhdikhai')
  })

  test('and does not have to', () => {
    // Adding a required key would break every manifest already written.
    const parsed = parseManifest('fleet: homelab\nservices:\n  web: { image: nginx }\n')
    assert.equal(parsed.project, undefined)
  })

  test('a project name that could not be a service name is rejected', () => {
    assert.throws(
      () => parseManifest('fleet: homelab\nproject: "Not Valid"\nservices:\n  web: { image: nginx }\n'),
      (err: Error) => /project names must be lowercase/.test(err.message)
    )
  })
})

describe('applying two projects into one fleet', () => {
  let ctx: AppContext
  let app: FastifyInstance
  let token: string
  let fleetId: string
  let orgId: string
  let userId: string

  before(async () => {
    ctx = createContext(loadConfig())
    app = await buildServer(ctx)
    const signup = await app.inject({
      method: 'POST',
      url: '/auth/signup',
      payload: { email: `proj-${Date.now()}@example.test`, password: 'a-long-enough-password' },
    })
    const b = signup.json()
    token = b.accessToken
    fleetId = b.fleet.id
    orgId = b.org.id
    userId = b.user.id
  })

  after(async () => {
    await app.close()
    await ctx.db.delete(orgs).where(eq(orgs.id, orgId))
    await ctx.db.delete(users).where(eq(users.id, userId))
    await closeContext(ctx)
  })

  const apply = (manifest: string, project?: string) =>
    app.inject({
      method: 'POST',
      url: `/fleets/${fleetId}/services`,
      headers: { authorization: `Bearer ${token}` },
      payload: { manifest, project },
    })

  test('services are tagged with the project they came from', async () => {
    const res = await apply('fleet: homelab\nservices:\n  api: { image: nginx }\n  db: { image: postgres:16 }\n', 'muhdikhai')
    assert.equal(res.statusCode, 200, res.body)
    assert.equal(res.json().project, 'muhdikhai')

    const rows = await ctx.db.select().from(services).where(eq(services.fleetId, fleetId))
    assert.deepEqual(new Set(rows.map((r) => r.project)), new Set(['muhdikhai']))
  })

  test('a project: key in the manifest wins over the caller default', async () => {
    // The file is portable; the directory name is a convenience.
    const res = await apply(
      'fleet: homelab\nproject: named-in-file\nservices:\n  worker: { image: alpine }\n',
      'from-the-directory'
    )
    assert.equal(res.json().project, 'named-in-file')
  })

  test('applying another project does NOT warn about the first', async () => {
    // The whole point. Computed across the fleet, "no longer in fleet.yaml"
    // warned about every service belonging to somebody else's manifest.
    const res = await apply('fleet: homelab\nservices:\n  site: { image: nginx }\n', 'otherproject')
    assert.equal(res.statusCode, 200, res.body)

    const body = res.json()
    assert.equal(body.project, 'otherproject')
    assert.deepEqual(body.orphaned, [], `warned about another project's services: ${body.orphaned}`)
    assert.deepEqual(
      body.warnings.filter((w: string) => /no longer/.test(w)),
      []
    )
  })

  test('but dropping a service from its own project still warns, and names the project', async () => {
    const res = await apply('fleet: homelab\nservices:\n  api: { image: nginx }\n', 'muhdikhai')
    const body = res.json()
    assert.deepEqual(body.orphaned, ['db'])
    assert.match(body.warnings.join('\n'), /"muhdikhai"/)
  })

  test('nothing was deleted — the other projects are untouched', async () => {
    const rows = await ctx.db.select().from(services).where(eq(services.fleetId, fleetId))
    const byProject = new Map<string, string[]>()
    for (const r of rows) byProject.set(r.project, [...(byProject.get(r.project) ?? []), r.name].sort())

    assert.deepEqual(byProject.get('muhdikhai')?.sort(), ['api', 'db'])
    assert.deepEqual(byProject.get('named-in-file'), ['worker'])
    assert.deepEqual(byProject.get('otherproject'), ['site'])
  })
})

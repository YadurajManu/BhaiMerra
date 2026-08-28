import 'dotenv/config'
import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { eq } from 'drizzle-orm'
import { createServer, request as httpRequest, type Server } from 'node:http'

import { loadConfig } from '../src/config.js'
import { createContext, closeContext, type AppContext } from '../src/api/context.js'
import { orgs, fleets, nodes, services, deployments } from '../src/db/schema.js'
import { hashToken, newAgentToken } from '../src/lib/tokens.js'
import {
  resolveRoute,
  invalidateRoutesForService,
  managedHostname,
  allocateHostPort,
  PORT_RANGE,
} from '../src/ingress/routes.js'
import { startIngress, type IngressServer } from '../src/ingress/proxy.js'

describe('managed hostnames', () => {
  const FLEET_A = '11111111-1111-1111-1111-111111111111'
  const FLEET_B = '22222222-2222-2222-2222-222222222222'

  test('are deterministic, so a URL can be shown before the first deploy', () => {
    assert.equal(
      managedHostname('web', 'homelab', FLEET_A, 'fleetos.app'),
      managedHostname('web', 'homelab', FLEET_A, 'fleetos.app')
    )
    assert.match(managedHostname('web', 'homelab', FLEET_A, 'fleetos.app'), /^web-homelab-[0-9a-f]{6}\.fleetos\.app$/)
  })

  test('two fleets both called "homelab" do not collide', () => {
    // The default name for everyone's first fleet is "homelab", so without a
    // globally unique component this collides on the very first deploy.
    assert.notEqual(
      managedHostname('web', 'homelab', FLEET_A, 'fleetos.app'),
      managedHostname('web', 'homelab', FLEET_B, 'fleetos.app')
    )
  })

  test('is a single DNS label, because a wildcard cert covers one level', () => {
    // `web.homelab-x.fleet.example.com` under `*.fleet.example.com` has no
    // valid certificate — every deployed service would fail TLS.
    const host = managedHostname('web', 'homelab', FLEET_A, 'fleet.example.com')
    const zoneless = host.replace('.fleet.example.com', '')
    assert.ok(!zoneless.includes('.'), `"${zoneless}" must be one label, not ${zoneless.split('.').length}`)
  })

  test('slug anything that is not DNS-safe', () => {
    assert.match(
      managedHostname('Img Proxy', "Yad's Lab", FLEET_A, 'fleetos.app'),
      /^img-proxy-yad-s-lab-[0-9a-f]{6}\.fleetos\.app$/
    )
  })
})

describe('routing and failover', () => {
  let ctx: AppContext
  let orgId: string
  let fleetId: string
  let serviceId: string
  const nodeIds: Record<string, string> = {}
  let upstreamA: Server
  let upstreamB: Server
  let portA = 0
  let portB = 0
  let edge: IngressServer

  before(async () => {
    ctx = createContext(loadConfig())

    // Two stand-in "containers" on two different ports.
    const makeUpstream = (name: string) =>
      createServer((req, res) => {
        res.writeHead(200, { 'content-type': 'text/plain' })
        res.end(`served by ${name} for ${req.headers.host}`)
      })
    upstreamA = makeUpstream('node-a')
    upstreamB = makeUpstream('node-b')
    await new Promise<void>((r) => upstreamA.listen(0, '127.0.0.1', r))
    await new Promise<void>((r) => upstreamB.listen(0, '127.0.0.1', r))
    portA = (upstreamA.address() as { port: number }).port
    portB = (upstreamB.address() as { port: number }).port

    const [org] = await ctx.db.insert(orgs).values({ name: 'ingress-test' }).returning()
    orgId = org!.id
    const [fleet] = await ctx.db.insert(fleets).values({ orgId, name: `ing-${Date.now()}` }).returning()
    fleetId = fleet!.id

    for (const name of ['node-a', 'node-b']) {
      const [n] = await ctx.db
        .insert(nodes)
        .values({
          fleetId, name, arch: 'amd64', cpuCores: 4, ramMb: 8192, diskMb: 100_000,
          agentTokenHash: hashToken(newAgentToken()), status: 'online',
          advertiseAddr: '127.0.0.1',
        })
        .returning()
      nodeIds[name] = n!.id
    }

    const [svc] = await ctx.db
      .insert(services)
      .values({
        fleetId, name: 'web', placementPolicy: 'flexible', requestRamMb: 256,
        hostname: `web.ing-${Date.now()}.fleetos.test`, containerPort: 8080,
      })
      .returning()
    serviceId = svc!.id

    await ctx.db.insert(deployments).values({
      serviceId, nodeId: nodeIds['node-a'], status: 'running', hostPort: portA,
    })

    edge = await startIngress(ctx, { port: 0, host: '127.0.0.1' })
  })

  after(async () => {
    await edge.close()
    await new Promise<void>((r) => upstreamA.close(() => r()))
    await new Promise<void>((r) => upstreamB.close(() => r()))
    await invalidateRoutesForService(ctx, serviceId)
    await ctx.db.delete(orgs).where(eq(orgs.id, orgId))
    await closeContext(ctx)
  })

  const hostname = async () => {
    const [s] = await ctx.db.select({ hostname: services.hostname }).from(services).where(eq(services.id, serviceId))
    return s!.hostname!
  }

  /**
   * Raw http, not fetch: `Host` is a forbidden header name in fetch, which
   * drops it silently — the proxy would then never see the hostname under
   * test, and every assertion would pass or fail for the wrong reason.
   */
  const get = (host: string, path = '/') =>
    new Promise<{ status: number; body: string; headers: Record<string, string | string[] | undefined> }>(
      (resolve, reject) => {
        const req = httpRequest(
          { host: '127.0.0.1', port: edge.port, path, method: 'GET', headers: { host } },
          (res) => {
            let body = ''
            res.on('data', (c) => (body += c))
            res.on('end', () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }))
          }
        )
        req.on('error', reject)
        req.end()
      }
    )

  const fetchThroughEdge = async () => {
    const res = await get(await hostname())
    return { status: res.status, body: res.body, node: res.headers['x-fleet-node'] as string | undefined }
  }

  test('a hostname resolves to the node currently running the service', async () => {
    const route = await resolveRoute(ctx, await hostname())
    assert.ok(route)
    assert.equal(route!.nodeName, 'node-a')
    assert.equal(route!.upstream, `127.0.0.1:${portA}`)
  })

  test('the proxy serves the upstream', async () => {
    const res = await fetchThroughEdge()
    assert.equal(res.status, 200)
    assert.match(res.body, /served by node-a/)
    assert.equal(res.node, 'node-a', 'the response names the node that served it')
  })

  test('an unknown hostname is a distinct error, not an upstream 404', async () => {
    // "Nothing serves this name" and "the app returned 404" need different fixes.
    const res = await get('nobody.here.test')
    assert.equal(res.status, 404)
    assert.equal(res.headers['x-fleet-ingress'], 'no_route')
  })

  test('FR-8: the same URL follows the service to a new node', async () => {
    // Exactly what a failover does: supersede, place elsewhere, repoint.
    await ctx.db
      .update(deployments)
      .set({ status: 'superseded' })
      .where(eq(deployments.serviceId, serviceId))
    await ctx.db.insert(deployments).values({
      serviceId, nodeId: nodeIds['node-b'], status: 'running', hostPort: portB,
    })
    await invalidateRoutesForService(ctx, serviceId)

    const res = await fetchThroughEdge()
    assert.equal(res.status, 200)
    assert.match(res.body, /served by node-b/, 'the URL must now reach the new node')
    assert.equal(res.node, 'node-b')
  })

  test('an unreachable upstream explains itself rather than hanging', async () => {
    await ctx.db
      .update(deployments)
      .set({ hostPort: 1 }) // nothing listens on port 1
      .where(eq(deployments.serviceId, serviceId))
    await invalidateRoutesForService(ctx, serviceId)

    const res = await get(await hostname())
    assert.equal(res.status, 502)
    assert.match(res.body, /being rescheduled|Could not reach/)
  })
})

describe('host port allocation', () => {
  let ctx: AppContext
  let orgId: string
  let fleetId: string
  let nodeId: string

  before(async () => {
    ctx = createContext(loadConfig())
    const [org] = await ctx.db.insert(orgs).values({ name: 'ports-test' }).returning()
    orgId = org!.id
    const [fleet] = await ctx.db.insert(fleets).values({ orgId, name: `ports-${Date.now()}` }).returning()
    fleetId = fleet!.id
    const [n] = await ctx.db
      .insert(nodes)
      .values({
        fleetId, name: 'n1', arch: 'amd64', cpuCores: 2, ramMb: 2048, diskMb: 10_000,
        agentTokenHash: hashToken(newAgentToken()), status: 'online',
      })
      .returning()
    nodeId = n!.id
  })

  after(async () => {
    await ctx.db.delete(orgs).where(eq(orgs.id, orgId))
    await closeContext(ctx)
  })

  test('allocates inside the documented range', async () => {
    const port = await allocateHostPort(ctx, nodeId)
    assert.ok(port >= PORT_RANGE.min && port <= PORT_RANGE.max, `${port} out of range`)
  })

  test('never hands out a port already live on that node', async () => {
    const [svc] = await ctx.db
      .insert(services)
      .values({ fleetId, name: `svc-${Date.now()}`, requestRamMb: 128 })
      .returning()

    const taken = await allocateHostPort(ctx, nodeId)
    await ctx.db.insert(deployments).values({
      serviceId: svc!.id, nodeId, status: 'running', hostPort: taken,
    })

    for (let i = 0; i < 40; i++) {
      assert.notEqual(await allocateHostPort(ctx, nodeId), taken)
    }
  })
})

/**
 * Replicas.
 *
 * `replicas` sat in the schema, was validated by the manifest, persisted, and
 * shipped to the agent — and read by nothing. `replicas: 3` produced one
 * container, silently, which is worse than the key not existing.
 *
 * The reconciler is deliberately separate from the deploy path. A replica
 * count is a statement about how many copies should exist, so as desired state
 * it repairs itself when one dies, and the most consequential code in the
 * system — the one that deploys everything — is left alone. The first test
 * here is the one that matters most: a service with the default of one replica
 * must behave exactly as it always did.
 */
import 'dotenv/config'
import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { and, eq, inArray } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'

import { loadConfig } from '../src/config.js'
import { createContext, closeContext, type AppContext } from '../src/api/context.js'
import { buildServer } from '../src/server.js'
import { orgs, users, services, deployments, nodes } from '../src/db/schema.js'
import { reconcileReplicas } from '../src/scheduler/replicas.js'
import { pickRoute, type Route } from '../src/ingress/routes.js'

describe('reconciling a replica count', () => {
  let ctx: AppContext
  let app: FastifyInstance
  let token: string
  let fleetId: string
  let orgId: string
  let userId: string
  const nodeIds: string[] = []

  before(async () => {
    ctx = createContext(loadConfig())
    app = await buildServer(ctx)

    const signup = await app.inject({
      method: 'POST',
      url: '/auth/signup',
      payload: { email: `replicas-${Date.now()}@example.test`, password: 'a-long-enough-password' },
    })
    const body = signup.json()
    token = body.accessToken
    fleetId = body.fleet.id
    orgId = body.org.id
    userId = body.user.id

    // Three nodes, so "spread across the fleet" has somewhere to spread to.
    for (const name of ['alpha', 'beta', 'gamma']) {
      const [n] = await ctx.db
        .insert(nodes)
        .values({
          fleetId,
          name,
          arch: 'amd64',
          os: 'linux',
          cpuCores: 4,
          ramMb: 8192,
          diskMb: 100_000,
          status: 'online',
          agentTokenHash: `hash-${name}-${Date.now()}`,
          advertiseAddr: `10.0.0.${nodeIds.length + 1}`,
          lastHeartbeatAt: new Date(),
        })
        .returning({ id: nodes.id })
      nodeIds.push(n!.id)
    }
  })

  after(async () => {
    await app.close()
    await ctx.db.delete(orgs).where(eq(orgs.id, orgId))
    await ctx.db.delete(users).where(eq(users.id, userId))
    await closeContext(ctx)
  })

  /** A service with one live deployment, as a normal deploy would leave it. */
  const seed = async (opts: {
    name: string
    replicas: number
    volume?: boolean
    pinned?: boolean
  }) => {
    const [svc] = await ctx.db
      .insert(services)
      .values({
        fleetId,
        name: opts.name,
        project: 'test',
        image: 'nginx:1.27-alpine',
        replicas: opts.replicas,
        requestRamMb: 128,
        requestCpu: '0.25',
        containerPort: 80,
        hostname: `${opts.name}-test.example`,
        placementPolicy: opts.pinned ? 'pinned' : 'flexible',
        pinnedNodeId: opts.pinned ? nodeIds[0] : null,
        persistentVolume: Boolean(opts.volume),
        volumeName: opts.volume ? `${opts.name}-data` : null,
      })
      .returning()
    await ctx.db.insert(deployments).values({
      serviceId: svc!.id,
      nodeId: nodeIds[0]!,
      status: 'running',
      imageTags: ['nginx:1.27-alpine'],
      hostPort: 30000 + Math.floor(Math.random() * 1000),
    })
    return svc!
  }

  const liveCount = async (serviceId: string) =>
    (
      await ctx.db
        .select({ id: deployments.id })
        .from(deployments)
        .where(
          and(eq(deployments.serviceId, serviceId), inArray(deployments.status, ['deploying', 'running']))
        )
    ).length

  test('a service with one replica is left completely alone', async () => {
    // The safety property. Every existing service in every existing fleet has
    // replicas = 1, and this must not touch any of them.
    const svc = await seed({ name: 'single', replicas: 1 })
    const outcomes = await reconcileReplicas(ctx, fleetId)
    assert.equal(outcomes.find((o) => o.service === 'single'), undefined)
    assert.equal(await liveCount(svc.id), 1)
  })

  test('scales up to the declared count', async () => {
    const svc = await seed({ name: 'web', replicas: 3 })
    const outcomes = await reconcileReplicas(ctx, fleetId)

    const scaled = outcomes.find((o) => o.service === 'web')
    assert.ok(scaled, `expected an outcome for web, got ${JSON.stringify(outcomes)}`)
    assert.equal(scaled.action, 'scaled_up')
    assert.equal(await liveCount(svc.id), 3)
  })

  test('puts each replica on a different node', async () => {
    // Three containers on one machine is not redundancy; losing that machine
    // still loses the service.
    const [svc] = await ctx.db
      .select()
      .from(services)
      .where(and(eq(services.fleetId, fleetId), eq(services.name, 'web')))

    const live = await ctx.db
      .select({ nodeId: deployments.nodeId })
      .from(deployments)
      .where(
        and(eq(deployments.serviceId, svc!.id), inArray(deployments.status, ['deploying', 'running']))
      )
    const distinct = new Set(live.map((d) => d.nodeId))
    assert.equal(distinct.size, live.length, 'every replica should be on its own node')
  })

  test('is idempotent once the count is met', async () => {
    // The sweeper runs this on every tick. Creating a replica each time would
    // be a fork bomb with a five-second fuse.
    const [svc] = await ctx.db
      .select()
      .from(services)
      .where(and(eq(services.fleetId, fleetId), eq(services.name, 'web')))
    const before = await liveCount(svc!.id)
    await reconcileReplicas(ctx, fleetId)
    await reconcileReplicas(ctx, fleetId)
    assert.equal(await liveCount(svc!.id), before)
  })

  test('replaces a replica that dies', async () => {
    // This is the reason it is desired state rather than a one-shot at deploy.
    const [svc] = await ctx.db
      .select()
      .from(services)
      .where(and(eq(services.fleetId, fleetId), eq(services.name, 'web')))

    const [victim] = await ctx.db
      .select({ id: deployments.id })
      .from(deployments)
      .where(
        and(eq(deployments.serviceId, svc!.id), inArray(deployments.status, ['deploying', 'running']))
      )
      .limit(1)
    await ctx.db
      .update(deployments)
      .set({ status: 'failed', failureReason: 'the container exited' })
      .where(eq(deployments.id, victim!.id))
    assert.equal(await liveCount(svc!.id), 2)

    await reconcileReplicas(ctx, fleetId)
    assert.equal(await liveCount(svc!.id), 3, 'the lost replica should be replaced')
  })

  test('scales down when the count is lowered', async () => {
    const [svc] = await ctx.db
      .select()
      .from(services)
      .where(and(eq(services.fleetId, fleetId), eq(services.name, 'web')))
    await ctx.db.update(services).set({ replicas: 2 }).where(eq(services.id, svc!.id))

    const outcomes = await reconcileReplicas(ctx, fleetId)
    assert.equal(outcomes.find((o) => o.service === 'web')?.action, 'scaled_down')
    assert.equal(await liveCount(svc!.id), 2)
  })

  test('refuses to scale a service holding a volume', async () => {
    // Two engines writing one data directory corrupt it. The manifest warns
    // about this; acting on it here would turn the warning into an outage.
    const svc = await seed({ name: 'db', replicas: 3, volume: true })
    const outcomes = await reconcileReplicas(ctx, fleetId)
    const blocked = outcomes.find((o) => o.service === 'db')
    assert.equal(blocked?.action, 'blocked')
    assert.match((blocked as { reason: string }).reason, /volume/)
    assert.equal(await liveCount(svc.id), 1, 'nothing should have been created')
  })

  test('refuses to scale a pinned service', async () => {
    const svc = await seed({ name: 'pinned-thing', replicas: 3, pinned: true })
    const outcomes = await reconcileReplicas(ctx, fleetId)
    const blocked = outcomes.find((o) => o.service === 'pinned-thing')
    assert.equal(blocked?.action, 'blocked')
    assert.equal(await liveCount(svc.id), 1)
  })

  test('says so when the fleet has run out of nodes', async () => {
    // Four replicas across three nodes: it should place what it can and
    // report the shortfall rather than stacking two on one machine.
    const svc = await seed({ name: 'toomany', replicas: 9 })
    const outcomes = await reconcileReplicas(ctx, fleetId)
    const blocked = outcomes.find((o) => o.service === 'toomany' && o.action === 'blocked')
    assert.ok(blocked, `expected a blocked outcome, got ${JSON.stringify(outcomes)}`)
    assert.ok(await liveCount(svc.id) <= 3, 'never more replicas than nodes')
  })

  test('a service that has never deployed is not started by scaling', async () => {
    // Scaling multiplies what exists; it is not a way to deploy something for
    // the first time, and treating it as one would run an image nobody chose.
    const [svc] = await ctx.db
      .insert(services)
      .values({
        fleetId,
        name: 'never-deployed',
        project: 'test',
        image: 'nginx:1.27-alpine',
        replicas: 3,
        requestRamMb: 128,
        requestCpu: '0.25',
        containerPort: 80,
        hostname: 'never-test.example',
      })
      .returning()
    await reconcileReplicas(ctx, fleetId)
    assert.equal(await liveCount(svc!.id), 0)
  })
})

describe('choosing which replica serves a request', () => {
  const route = (name: string): Route => ({
    hostname: 'x.example',
    serviceId: 's',
    serviceName: 'web',
    fleetId: 'f',
    nodeId: name,
    nodeName: name,
    upstream: `${name}:8080`,
    healthCheckPath: '/',
  })

  test('one replica always wins', () => {
    assert.equal(pickRoute([route('a')])?.nodeName, 'a')
  })

  test('no replica is not an error', () => {
    assert.equal(pickRoute([]), null)
  })

  test('several replicas all get traffic', () => {
    // A single cached route would have pinned the whole TTL to one replica,
    // which is load balancing in name only.
    const routes = [route('a'), route('b'), route('c')]
    const seen = new Set<string>()
    for (let i = 0; i < 400; i++) seen.add(pickRoute(routes)!.nodeName)
    assert.equal(seen.size, 3, `every replica should be chosen sometimes, saw ${[...seen]}`)
  })
})

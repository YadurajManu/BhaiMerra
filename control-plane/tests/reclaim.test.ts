import 'dotenv/config'
import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { eq, and, inArray } from 'drizzle-orm'

import { loadConfig } from '../src/config.js'
import { createContext, closeContext, type AppContext } from '../src/api/context.js'
import { orgs, fleets, nodes, services, deployments } from '../src/db/schema.js'
import { hashToken, newAgentToken } from '../src/lib/tokens.js'
import { reclaimToNode } from '../src/scheduler/reclaim.js'

describe('reclaim policies (FR-9)', () => {
  let ctx: AppContext
  let orgId: string
  let fleetId: string
  const n: Record<string, string> = {}

  before(async () => {
    ctx = createContext(loadConfig())
    const [org] = await ctx.db.insert(orgs).values({ name: 'reclaim-test' }).returning()
    orgId = org!.id
    const [fleet] = await ctx.db
      .insert(fleets)
      .values({ orgId, name: `reclaim-${Date.now()}`, defaultReclaimPolicy: 'idle' })
      .returning()
    fleetId = fleet!.id

    for (const name of ['home', 'spare']) {
      const [node] = await ctx.db
        .insert(nodes)
        .values({
          fleetId, name, arch: 'amd64', cpuCores: 4, ramMb: 8192, diskMb: 100_000,
          agentTokenHash: hashToken(newAgentToken()), status: 'online',
        })
        .returning()
      n[name] = node!.id
    }
  })

  after(async () => {
    await ctx.db.delete(orgs).where(eq(orgs.id, orgId))
    await closeContext(ctx)
  })

  const makeService = async (name: string, reclaim: 'eager' | 'idle' | 'manual' | null, on: string) => {
    const [svc] = await ctx.db
      .insert(services)
      .values({
        fleetId, name, placementPolicy: 'preferred', pinnedNodeId: n['home'],
        requestRamMb: 256, reclaimPolicy: reclaim, compatibleArches: ['amd64'],
      })
      .returning()
    await ctx.db.insert(deployments).values({ serviceId: svc!.id, nodeId: on, status: 'running' })
    return svc!.id
  }

  const nodeOf = async (serviceId: string) => {
    const [row] = await ctx.db
      .select({ nodeId: deployments.nodeId, status: deployments.status, startedAt: deployments.startedAt })
      .from(deployments)
      .where(and(eq(deployments.serviceId, serviceId), inArray(deployments.status, ['deploying', 'running'])))
      .limit(1)
    return row
  }

  test('eager moves the service back to its node', async () => {
    const id = await makeService('eager-svc', 'eager', n['spare']!)
    const outcomes = await reclaimToNode(ctx, fleetId, n['home']!)
    const mine = outcomes.find((o) => o.service === 'eager-svc')

    assert.equal(mine?.action, 'reclaimed')
    assert.equal((await nodeOf(id))?.nodeId, n['home'], 'it should be home again')
  })

  test('idle leaves it where it landed until the next deploy', async () => {
    // A surprise restart is worse than suboptimal placement, which is why
    // this is the default.
    const id = await makeService('idle-svc', 'idle', n['spare']!)
    const outcomes = await reclaimToNode(ctx, fleetId, n['home']!)
    const mine = outcomes.find((o) => o.service === 'idle-svc')

    assert.equal(mine?.action, 'left')
    assert.match(mine!.detail, /until the next deploy/)
    assert.equal((await nodeOf(id))?.nodeId, n['spare'], 'it must not have moved')
  })

  test('manual waits for a human', async () => {
    const id = await makeService('manual-svc', 'manual', n['spare']!)
    const outcomes = await reclaimToNode(ctx, fleetId, n['home']!)
    const mine = outcomes.find((o) => o.service === 'manual-svc')

    assert.equal(mine?.action, 'left')
    assert.match(mine!.detail, /manual confirmation/)
    assert.equal((await nodeOf(id))?.nodeId, n['spare'])
  })

  test('a service with no policy inherits the fleet default', async () => {
    const id = await makeService('inherit-svc', null, n['spare']!)
    const outcomes = await reclaimToNode(ctx, fleetId, n['home']!)
    // The fleet default is idle, so it should stay put.
    assert.equal(outcomes.find((o) => o.service === 'inherit-svc')?.action, 'left')
    assert.equal((await nodeOf(id))?.nodeId, n['spare'])
  })

  test('a pinned service held on the node is resumed, not reclaimed', async () => {
    // It never left, so there is nothing to move — it just needs starting.
    const [svc] = await ctx.db
      .insert(services)
      .values({
        fleetId, name: 'pinned-db', placementPolicy: 'pinned', pinnedNodeId: n['home'],
        requestRamMb: 512, persistentVolume: true, volumeName: 'pgdata', compatibleArches: ['amd64'],
      })
      .returning()
    await ctx.db
      .insert(deployments)
      .values({ serviceId: svc!.id, nodeId: n['home'], status: 'pinned_unavailable' })

    const outcomes = await reclaimToNode(ctx, fleetId, n['home']!)
    const mine = outcomes.find((o) => o.service === 'pinned-db')

    assert.equal(mine?.action, 'resumed')
    const row = await nodeOf(svc!.id)
    assert.equal(row?.status, 'deploying', 'the agent will start it on its next poll')
    assert.equal(row?.nodeId, n['home'])
  })

  test('a resumed deployment gets a fresh rollout window', async () => {
    // The outage this prevents. A held deployment carries the startedAt from
    // before its node went away, and the rollout window is measured from that
    // timestamp -- so resuming it without a reset produces a row that is
    // already past its own deadline. failStalledRollouts then failed it within
    // the minute, before the agent had polled once, and the agent reaped the
    // container for being absent from desired state. A database went that way
    // after a control-plane restart of about ninety seconds.
    const [svc] = await ctx.db
      .insert(services)
      .values({
        fleetId, name: 'long-held', placementPolicy: 'pinned', pinnedNodeId: n['home'],
        requestRamMb: 512, persistentVolume: true, volumeName: 'helddata', compatibleArches: ['amd64'],
      })
      .returning()

    // Held since long before any rollout window would have elapsed.
    const longAgo = new Date(Date.now() - 6 * 60 * 60_000)
    await ctx.db
      .insert(deployments)
      .values({ serviceId: svc!.id, nodeId: n['home'], status: 'pinned_unavailable', startedAt: longAgo })

    await reclaimToNode(ctx, fleetId, n['home']!)

    const row = await nodeOf(svc!.id)
    assert.equal(row?.status, 'deploying')
    assert.ok(
      row!.startedAt.getTime() > Date.now() - 60_000,
      'the window has to start when the rollout does, or the sweep kills it before the agent polls'
    )
  })

  test('a service stranded with nowhere to go is placed once there is somewhere', async () => {
    // When a node goes down, a flexible service on it is re-placed -- unless
    // nothing can take it, in which case reschedule writes failed /
    // no_eligible_node. That was terminal: nothing ever revisited it, so on a
    // single-node fleet every flexible service stayed dead after its node came
    // back while the pinned ones beside it were resumed. A strand is a
    // statement about capacity at one moment, not a property of the service.
    const [svc] = await ctx.db
      .insert(services)
      .values({
        fleetId, name: 'stranded-web', placementPolicy: 'flexible',
        requestRamMb: 256, compatibleArches: ['amd64'],
      })
      .returning()
    await ctx.db
      .insert(deployments)
      .values({
        serviceId: svc!.id,
        nodeId: n['home'],
        status: 'failed',
        failureReason: 'no_eligible_node',
      })

    const outcomes = await reclaimToNode(ctx, fleetId, n['home']!)
    const mine = outcomes.find((o) => o.service === 'stranded-web')
    assert.equal(mine?.action, 'unstranded', 'a returning node is capacity; the strand should clear')

    const row = await nodeOf(svc!.id)
    assert.equal(row?.status, 'deploying', 'it needs a live deployment, not just a nicer status')

    // The failed row stays, because it is the record of what happened.
    const [old] = await ctx.db
      .select({ status: deployments.status })
      .from(deployments)
      .where(and(eq(deployments.serviceId, svc!.id), eq(deployments.failureReason, 'no_eligible_node')))
      .limit(1)
    assert.equal(old?.status, 'failed', 'history should not be rewritten to look seamless')
  })

  test('a service that is already running is not disturbed by the strand sweep', async () => {
    // An old no_eligible_node row must not cause a second deployment of
    // something that recovered by other means -- a redeploy, say.
    const [svc] = await ctx.db
      .insert(services)
      .values({
        fleetId, name: 'recovered-web', placementPolicy: 'flexible',
        requestRamMb: 256, compatibleArches: ['amd64'],
      })
      .returning()
    await ctx.db.insert(deployments).values([
      { serviceId: svc!.id, nodeId: n['home'], status: 'failed', failureReason: 'no_eligible_node' },
      { serviceId: svc!.id, nodeId: n['home'], status: 'running' },
    ])

    const outcomes = await reclaimToNode(ctx, fleetId, n['home']!)
    assert.ok(
      !outcomes.some((o) => o.service === 'recovered-web'),
      'it is live; the stale strand row says nothing about it now'
    )
  })

  test('a service already on the returning node is left alone', async () => {
    const id = await makeService('already-home', 'eager', n['home']!)
    const outcomes = await reclaimToNode(ctx, fleetId, n['home']!)
    assert.equal(outcomes.find((o) => o.service === 'already-home'), undefined)
    assert.equal((await nodeOf(id))?.nodeId, n['home'])
  })
})

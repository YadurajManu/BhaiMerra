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
      .select({ nodeId: deployments.nodeId, status: deployments.status })
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

  test('a service already on the returning node is left alone', async () => {
    const id = await makeService('already-home', 'eager', n['home']!)
    const outcomes = await reclaimToNode(ctx, fleetId, n['home']!)
    assert.equal(outcomes.find((o) => o.service === 'already-home'), undefined)
    assert.equal((await nodeOf(id))?.nodeId, n['home'])
  })
})

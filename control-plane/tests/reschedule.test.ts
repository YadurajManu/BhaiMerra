import 'dotenv/config'
import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { eq, and, inArray } from 'drizzle-orm'

import { loadConfig } from '../src/config.js'
import { createContext, closeContext, type AppContext } from '../src/api/context.js'
import { sweepOnce } from '../src/heartbeat/sweeper.js'
import { orgs, fleets, nodes, services, deployments, placementEvents } from '../src/db/schema.js'
import { hashToken, newAgentToken } from '../src/lib/tokens.js'
import type { FleetEventPayload } from '../src/lib/events.js'

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * The scenario the whole product exists for: a node with two services on it
 * goes dark. One is stateless and must move. One is pinned to a volume and
 * must NOT move, but must be loudly reported.
 */
describe('failover rescheduling (FR-6, FR-7)', () => {
  let ctx: AppContext
  let orgId: string
  let fleetId: string
  const nodeIds: Record<string, string> = {}
  const serviceIds: Record<string, string> = {}
  const events: FleetEventPayload[] = []

  before(async () => {
    ctx = createContext(loadConfig())

    const [org] = await ctx.db.insert(orgs).values({ name: 'reschedule-test' }).returning()
    orgId = org!.id
    const [fleet] = await ctx.db
      .insert(fleets)
      .values({
        orgId,
        name: `reschedule-${Date.now()}`,
        heartbeatIntervalSec: 1,
        heartbeatMissThreshold: 1,
      })
      .returning()
    fleetId = fleet!.id

    const spec = [
      { name: 'home-server', ramMb: 16384, tier: 'high' as const },
      { name: 'thinkpad', ramMb: 8192, tier: 'opportunistic' as const },
      { name: 'vps-fra', ramMb: 2048, tier: 'high' as const },
    ]
    for (const s of spec) {
      const [n] = await ctx.db
        .insert(nodes)
        .values({
          fleetId,
          name: s.name,
          arch: 'amd64',
          cpuCores: 4,
          ramMb: s.ramMb,
          diskMb: 100_000,
          reliabilityTier: s.tier,
          agentTokenHash: hashToken(newAgentToken()),
          status: 'online',
        })
        .returning()
      nodeIds[s.name] = n!.id
    }

    // Both services start on thinkpad — the machine about to disappear.
    const [imgProxy] = await ctx.db
      .insert(services)
      .values({
        fleetId,
        name: 'img-proxy',
        placementPolicy: 'flexible',
        requestRamMb: 768,
        compatibleArches: ['amd64'],
      })
      .returning()
    serviceIds['img-proxy'] = imgProxy!.id

    const [postgres] = await ctx.db
      .insert(services)
      .values({
        fleetId,
        name: 'postgres',
        placementPolicy: 'pinned',
        pinnedNodeId: nodeIds['thinkpad'],
        requestRamMb: 1024,
        persistentVolume: true,
        volumeName: 'pgdata',
        compatibleArches: ['amd64'],
      })
      .returning()
    serviceIds['postgres'] = postgres!.id

    for (const name of ['img-proxy', 'postgres']) {
      await ctx.db.insert(deployments).values({
        serviceId: serviceIds[name]!,
        nodeId: nodeIds['thinkpad'],
        status: 'running',
        gitSha: '4f1c9ae',
        imageTags: [`registry.local/${name}:4f1c9ae`],
      })
    }
  })

  after(async () => {
    await ctx.redis.del(`fleet:${fleetId}:hb`)
    for (const id of Object.values(nodeIds)) await ctx.redis.del(`node:${id}:hb`, `node:${id}:down`)
    await ctx.db.delete(orgs).where(eq(orgs.id, orgId))
    await closeContext(ctx)
  })

  const beat = (name: string) =>
    ctx.heartbeats.record({
      nodeId: nodeIds[name]!,
      fleetId,
      cpuPct: 20,
      ramUsedMb: 1024,
      diskUsedMb: 10_000,
      containers: [],
      meshConnected: true,
    })

  const sweep = async () => {
    const result = await sweepOnce(ctx, {
      onEvent: (e) => {
        if (e.fleetId === fleetId) events.push(e)
      },
    })
    return result.rescheduled.filter((r) => Object.values(nodeIds).includes(r.nodeId))
  }

  test('thinkpad goes dark and its workloads are acted on', async () => {
    await Promise.all(['home-server', 'thinkpad', 'vps-fra'].map(beat))
    await wait(1300)
    // Only the two survivors keep reporting.
    await Promise.all([beat('home-server'), beat('vps-fra')])

    const rescheduled = await sweep()
    assert.equal(rescheduled.length, 1, 'one node should have triggered a reschedule')
    assert.equal(rescheduled[0]!.nodeId, nodeIds['thinkpad'])
    assert.equal(rescheduled[0]!.outcomes.length, 2, 'both services must be accounted for')
  })

  test('FR-6: the flexible service moved to the best eligible node', async () => {
    const [row] = await ctx.db
      .select({ nodeId: deployments.nodeId, status: deployments.status })
      .from(deployments)
      .where(
        and(
          eq(deployments.serviceId, serviceIds['img-proxy']!),
          inArray(deployments.status, ['deploying', 'running'])
        )
      )

    assert.ok(row, 'img-proxy should have a live deployment')
    assert.notEqual(row!.nodeId, nodeIds['thinkpad'], 'it must have left the dead node')
    // home-server has far more headroom than the 2GB vps, and both are high tier.
    assert.equal(row!.nodeId, nodeIds['home-server'])
  })

  test('the old deployment is superseded, not deleted, so the timeline survives', async () => {
    const rows = await ctx.db
      .select({ status: deployments.status, nodeId: deployments.nodeId })
      .from(deployments)
      .where(eq(deployments.serviceId, serviceIds['img-proxy']!))

    assert.equal(rows.length, 2)
    const old = rows.find((r) => r.nodeId === nodeIds['thinkpad'])
    assert.equal(old!.status, 'superseded')
  })

  test('a placement event records why that node won', async () => {
    const [event] = await ctx.db
      .select()
      .from(placementEvents)
      .where(eq(placementEvents.serviceId, serviceIds['img-proxy']!))

    assert.ok(event, 'a placement event should exist')
    assert.equal(event!.reason, 'failover')
    assert.equal(event!.fromNodeId, nodeIds['thinkpad'])
    assert.equal(event!.toNodeId, nodeIds['home-server'])
    assert.ok(typeof event!.detail?.score === 'number', 'the winning score is recorded')
    assert.ok(Array.isArray(event!.detail?.rejected), 'so is who lost, and why')
  })

  test('FR-7: the pinned service did NOT move', async () => {
    const rows = await ctx.db
      .select({ nodeId: deployments.nodeId, status: deployments.status })
      .from(deployments)
      .where(eq(deployments.serviceId, serviceIds['postgres']!))

    assert.equal(rows.length, 1, 'no new deployment should have been created for a pinned service')
    assert.equal(rows[0]!.nodeId, nodeIds['thinkpad'], 'it must stay with its volume')
    assert.equal(rows[0]!.status, 'failed')

    const moved = await ctx.db
      .select()
      .from(placementEvents)
      .where(eq(placementEvents.serviceId, serviceIds['postgres']!))
    assert.equal(moved.length, 0, 'a pinned service must generate no placement event')
  })

  test('the pinned failure raises its own distinct alert, not a reschedule notice', async () => {
    const pinned = events.filter((e) => e.type === 'service.pinned_unavailable')
    assert.equal(pinned.length, 1)
    assert.equal(pinned[0]!.subject, 'postgres')

    const moves = events.filter((e) => e.type === 'service.rescheduled')
    assert.equal(moves.length, 1)
    assert.equal(moves[0]!.subject, 'img-proxy')
    assert.equal(moves[0]!.detail?.to, 'home-server')
  })

  test('a second sweep does not move anything again', async () => {
    await Promise.all([beat('home-server'), beat('vps-fra')])
    const rescheduled = await sweep()
    assert.deepEqual(rescheduled, [], 'the node is already down; nothing left to do')
  })
})

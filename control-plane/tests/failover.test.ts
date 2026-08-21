import 'dotenv/config'
import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { eq, inArray } from 'drizzle-orm'

import { loadConfig } from '../src/config.js'
import { createContext, closeContext, type AppContext } from '../src/api/context.js'
import { sweepOnce } from '../src/heartbeat/sweeper.js'
import { orgs, fleets, nodes } from '../src/db/schema.js'
import { hashToken, newAgentToken } from '../src/lib/tokens.js'
import type { FleetEventPayload } from '../src/lib/events.js'

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * The integration test the tech doc §12 asks for: register three nodes, stop
 * one heartbeating, assert it is detected and that the others are untouched.
 *
 * The fleet is configured with a 1s interval and a 1-miss threshold so the
 * test exercises real elapsed time rather than a faked clock — the thing most
 * likely to be wrong here is an off-by-one in the staleness window, and a
 * mocked clock would hide exactly that.
 */
describe('heartbeat failure detection (FR-5)', () => {
  let ctx: AppContext
  let fleetId: string
  let orgId: string
  const nodeIds: Record<string, string> = {}
  const events: FleetEventPayload[] = []

  before(async () => {
    ctx = createContext(loadConfig())

    const [org] = await ctx.db.insert(orgs).values({ name: 'failover-test-org' }).returning()
    orgId = org!.id
    const [fleet] = await ctx.db
      .insert(fleets)
      .values({
        orgId,
        name: `failover-test-${Date.now()}`,
        heartbeatIntervalSec: 1,
        heartbeatMissThreshold: 1,
      })
      .returning()
    fleetId = fleet!.id

    for (const name of ['always-on', 'flaky', 'vps']) {
      const [node] = await ctx.db
        .insert(nodes)
        .values({
          fleetId,
          name,
          arch: 'amd64',
          cpuCores: 4,
          ramMb: 8192,
          diskMb: 100_000,
          agentTokenHash: hashToken(newAgentToken()),
          status: 'online',
        })
        .returning()
      nodeIds[name] = node!.id
    }
  })

  after(async () => {
    await ctx.redis.del(`fleet:${fleetId}:hb`)
    for (const id of Object.values(nodeIds)) {
      await ctx.redis.del(`node:${id}:hb`, `node:${id}:down`)
    }
    await ctx.db.delete(orgs).where(eq(orgs.id, orgId)) // cascades to fleet + nodes
    await closeContext(ctx)
  })

  const beat = (name: string) =>
    ctx.heartbeats.record({
      nodeId: nodeIds[name]!,
      fleetId,
      cpuPct: 12,
      ramUsedMb: 1024,
      diskUsedMb: 20_000,
      containers: [],
      meshConnected: true,
    })

  /** sweepOnce covers every fleet in the database, so scope to ours. */
  const sweep = async () => {
    const result = await sweepOnce(ctx, {
      onEvent: (e) => {
        if (e.fleetId === fleetId) events.push(e)
      },
    })
    return result.markedDown.filter((n) => n.fleetId === fleetId)
  }

  test('all three nodes beating: nothing is marked down', async () => {
    await Promise.all(['always-on', 'flaky', 'vps'].map(beat))
    assert.deepEqual(await sweep(), [])
  })

  test('a node that stops beating is marked down, and only that node', async () => {
    // Let every node age past the 1s window, then beat only the healthy two
    // immediately before sweeping. 'flaky' is the sole node outside the window.
    await wait(1300)
    await Promise.all([beat('always-on'), beat('vps')])

    const markedDown = await sweep()

    assert.equal(markedDown.length, 1, 'exactly one node should transition')
    assert.equal(markedDown[0]!.name, 'flaky')

    const rows = await ctx.db
      .select({ name: nodes.name, status: nodes.status })
      .from(nodes)
      .where(inArray(nodes.id, Object.values(nodeIds)))
    const byName = Object.fromEntries(rows.map((r) => [r.name, r.status]))

    assert.equal(byName['flaky'], 'offline')
    assert.equal(byName['always-on'], 'online', 'a healthy node must not be swept')
    assert.equal(byName['vps'], 'online')
  })

  test('a node.down event is emitted with the reason', async () => {
    const down = events.filter((e) => e.type === 'node.down')
    assert.equal(down.length, 1)
    assert.equal(down[0]!.subject, 'flaky')
    assert.equal(down[0]!.fleetId, fleetId)
    assert.equal(down[0]!.detail?.missedThreshold, 1)
  })

  test('sweeping again does not re-alert for an already-down node', async () => {
    const before = events.length
    await Promise.all([beat('always-on'), beat('vps')])
    const markedDown = await sweep()
    assert.deepEqual(markedDown, [], 'already-offline nodes must not transition twice')
    assert.equal(events.length, before, 'no duplicate alert')
  })

  test('the down marker is set so the heartbeat route can detect recovery', async () => {
    assert.equal(await ctx.redis.get(`node:${nodeIds['flaky']}:down`), '1')
  })

  test('a cordoned node is never swept', async () => {
    await ctx.db
      .update(nodes)
      .set({ status: 'cordoned' })
      .where(eq(nodes.id, nodeIds['vps']!))
    // let vps go quiet while always-on keeps reporting
    await wait(1300)
    await beat('always-on')

    const markedDown = await sweep()
    assert.equal(
      markedDown.find((n) => n.name === 'vps'),
      undefined,
      'cordoned means the operator already knows'
    )

    const [row] = await ctx.db
      .select({ status: nodes.status })
      .from(nodes)
      .where(eq(nodes.id, nodeIds['vps']!))
    assert.equal(row!.status, 'cordoned')
  })
})

/**
 * Regression: found by running the real agent, not by the tests above — every
 * test here beat each node at least once before going quiet, which hid it.
 */
describe('a node that registers but never heartbeats', () => {
  let ctx: AppContext
  let orgId: string
  let fleetId: string
  let nodeId: string

  before(async () => {
    ctx = createContext(loadConfig())
    const [org] = await ctx.db.insert(orgs).values({ name: 'silent-node-test' }).returning()
    orgId = org!.id
    const [fleet] = await ctx.db
      .insert(fleets)
      .values({
        orgId,
        name: `silent-${Date.now()}`,
        heartbeatIntervalSec: 1,
        heartbeatMissThreshold: 1,
      })
      .returning()
    fleetId = fleet!.id

    const [node] = await ctx.db
      .insert(nodes)
      .values({
        fleetId,
        name: 'paired-but-dead',
        arch: 'amd64',
        cpuCores: 4,
        ramMb: 8192,
        diskMb: 100_000,
        agentTokenHash: hashToken(newAgentToken()),
        status: 'online', // exactly what /agent/register writes
        lastHeartbeatAt: new Date(),
      })
      .returning()
    nodeId = node!.id

    // What the register route now does.
    await ctx.heartbeats.markRegistered(fleetId, nodeId)
  })

  after(async () => {
    await ctx.redis.del(`fleet:${fleetId}:hb`, `node:${nodeId}:hb`, `node:${nodeId}:down`)
    await ctx.db.delete(orgs).where(eq(orgs.id, orgId))
    await closeContext(ctx)
  })

  test('is swept like any other node instead of looking healthy forever', async () => {
    await wait(1300)
    await sweepOnce(ctx)

    // Assert the outcome, not which sweep produced it. A control plane may be
    // running alongside the tests, and its own sweeper will happily win the
    // race — that is correct behaviour, and the test should not care who
    // marked the node down, only that it is down.
    const [row] = await ctx.db.select({ status: nodes.status }).from(nodes).where(eq(nodes.id, nodeId))
    assert.equal(row!.status, 'offline', 'a registered node that never beat must still go down')
  })

  test('reports no telemetry rather than fabricating a heartbeat', async () => {
    assert.equal(await ctx.heartbeats.last(nodeId), null)
  })
})

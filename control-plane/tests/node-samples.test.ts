/**
 * Telemetry history.
 *
 * The behaviour worth pinning down is the retention shape. Sampling is easy;
 * what keeps the table at ~3 MB per node per month rather than a gigabyte is
 * that fine-grain rows are rolled up and then actually deleted, and that a
 * chart asking for a month does not scan a month of ten-second samples.
 */
import 'dotenv/config'
import { test, describe, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { eq, and } from 'drizzle-orm'

import { loadConfig } from '../src/config.js'
import { createContext, closeContext, type AppContext } from '../src/api/context.js'
import { orgs, fleets, nodes, nodeSamples } from '../src/db/schema.js'
import {
  recordSamples,
  compactSamples,
  samplesFor,
  grainFor,
  latestSample,
  RETAIN_MS,
} from '../src/heartbeat/samples.js'

let ctx: AppContext
let nodeId: string
let orgId: string

const MIN = 60_000
const ago = (ms: number) => new Date(Date.now() - ms)

before(async () => {
  ctx = createContext(loadConfig())
  const [org] = await ctx.db.insert(orgs).values({ name: 'samples-test' }).returning()
  orgId = org!.id
  const [f] = await ctx.db.insert(fleets).values({ orgId, name: 'homelab' }).returning()
  const [n] = await ctx.db
    .insert(nodes)
    .values({
      fleetId: f!.id, name: 'pi', arch: 'arm64',
      cpuCores: 4, ramMb: 4096, diskMb: 32768, agentTokenHash: 'h',
    } as never)
    .returning()
  nodeId = n!.id
})

beforeEach(async () => {
  await ctx.db.delete(nodeSamples).where(eq(nodeSamples.nodeId, nodeId))
})

after(async () => {
  await ctx.db.delete(orgs).where(eq(orgs.id, orgId))
  await closeContext(ctx)
})

const sample = (at: Date, over: Partial<{ cpuPct: number; ramUsedMb: number; diskUsedMb: number; diskTotalMb: number; containers: number }> = {}) => ({
  nodeId,
  at,
  cpuPct: over.cpuPct ?? 20,
  ramUsedMb: over.ramUsedMb ?? 2048,
  diskUsedMb: over.diskUsedMb ?? 10_000,
  diskTotalMb: over.diskTotalMb ?? 40_000,
  containers: over.containers ?? 3,
})

describe('recording', () => {
  test('stores a reading and reads it back', async () => {
    await recordSamples(ctx, [sample(new Date())])
    const rows = await samplesFor(ctx, nodeId, 10 * MIN)
    assert.equal(rows.length, 1)
    assert.equal(rows[0]!.cpuPct, 20)
    assert.equal(rows[0]!.diskTotalMb, 40_000, 'the total is what a used-of-total reading needs')
  })

  test('floors to ten seconds, so two beats a moment apart are one point', async () => {
    // Heartbeats do not arrive on a tidy cadence. Without flooring, two beats
    // milliseconds apart become two rows that a chart draws as a spike.
    const base = Date.now()
    await recordSamples(ctx, [sample(new Date(base))])
    await recordSamples(ctx, [sample(new Date(base + 1200), { cpuPct: 90 })])

    const rows = await samplesFor(ctx, nodeId, 10 * MIN)
    assert.equal(rows.length, 1, 'same bucket')
    assert.equal(rows[0]!.cpuPct, 90, 'the later reading wins')
  })

  test('a retried heartbeat updates rather than duplicating', async () => {
    const at = new Date()
    await recordSamples(ctx, [sample(at)])
    await recordSamples(ctx, [sample(at)])
    assert.equal((await samplesFor(ctx, nodeId, 10 * MIN)).length, 1)
  })

  test('writing nothing is not an error', async () => {
    assert.equal(await recordSamples(ctx, []), 0)
  })

  test('returns points oldest first, which is the order a chart draws', async () => {
    await recordSamples(ctx, [
      sample(ago(3 * MIN), { cpuPct: 10 }),
      sample(ago(1 * MIN), { cpuPct: 30 }),
      sample(ago(2 * MIN), { cpuPct: 20 }),
    ])
    const rows = await samplesFor(ctx, nodeId, 10 * MIN)
    assert.deepEqual(rows.map((r) => r.cpuPct), [10, 20, 30])
  })
})

describe('choosing a grain', () => {
  test('picks the finest that covers the window', () => {
    assert.equal(grainFor(30 * MIN), 'fine')
    assert.equal(grainFor(6 * 60 * MIN), 'minute')
    assert.equal(grainFor(7 * 24 * 60 * MIN), 'hour')
  })

  test('coarser grains are retained longer than finer ones', () => {
    // The whole retention design in one assertion: recent history at high
    // resolution, old history only as a trend.
    assert.ok(RETAIN_MS.fine < RETAIN_MS.minute)
    assert.ok(RETAIN_MS.minute < RETAIN_MS.hour)
  })
})

describe('compaction', () => {
  test('rolls fine samples into minutes and deletes what it consumed', async () => {
    const old = Date.now() - RETAIN_MS.fine - 5 * MIN
    await recordSamples(ctx, [
      { ...sample(new Date(old), { cpuPct: 10 }) },
      { ...sample(new Date(old + 10_000), { cpuPct: 30 }) },
      { ...sample(new Date(old + 20_000), { cpuPct: 50 }) },
    ])

    await compactSamples(ctx)

    const fine = await ctx.db
      .select()
      .from(nodeSamples)
      .where(and(eq(nodeSamples.nodeId, nodeId), eq(nodeSamples.grain, 'fine')))
    assert.equal(fine.length, 0, 'consumed fine rows are deleted, not left behind')

    const minute = await ctx.db
      .select()
      .from(nodeSamples)
      .where(and(eq(nodeSamples.nodeId, nodeId), eq(nodeSamples.grain, 'minute')))
    assert.equal(minute.length, 1, 'three samples in one minute became one row')
    assert.equal(Math.round(minute[0]!.cpuPct!), 30, 'cpu is averaged')
  })

  test('disk takes the last value rather than the mean', async () => {
    // Disk is a level, not a rate. Averaging an hour of it understates how full
    // the disk is right now, which is the number someone acts on.
    const old = Date.now() - RETAIN_MS.fine - 5 * MIN
    await recordSamples(ctx, [
      { ...sample(new Date(old), { diskUsedMb: 1000 }) },
      { ...sample(new Date(old + 10_000), { diskUsedMb: 9000 }) },
    ])
    await compactSamples(ctx)

    const [row] = await ctx.db
      .select()
      .from(nodeSamples)
      .where(and(eq(nodeSamples.nodeId, nodeId), eq(nodeSamples.grain, 'minute')))
    assert.equal(row!.diskUsedMb, 9000, 'the most recent level, not the average')
  })

  test('recent samples are left alone', async () => {
    await recordSamples(ctx, [sample(new Date())])
    await compactSamples(ctx)
    const fine = await ctx.db
      .select()
      .from(nodeSamples)
      .where(and(eq(nodeSamples.nodeId, nodeId), eq(nodeSamples.grain, 'fine')))
    assert.equal(fine.length, 1, 'inside the retention window, so untouched')
  })

  test('compacting an empty table does nothing and does not throw', async () => {
    const r = await compactSamples(ctx)
    assert.deepEqual(r, { toMinute: 0, toHour: 0, dropped: 0 })
  })

  test('is safe to run twice', async () => {
    const old = Date.now() - RETAIN_MS.fine - 5 * MIN
    await recordSamples(ctx, [sample(new Date(old))])
    await compactSamples(ctx)
    await compactSamples(ctx)
    const minute = await ctx.db
      .select()
      .from(nodeSamples)
      .where(and(eq(nodeSamples.nodeId, nodeId), eq(nodeSamples.grain, 'minute')))
    assert.equal(minute.length, 1, 'no duplicate rollups')
  })
})

describe('latest sample', () => {
  test('is what an offline node can still show', async () => {
    // An offline node has no live telemetry but two days of history. Showing
    // where it stopped is how you tell "died under load" from "lid closed".
    await recordSamples(ctx, [
      sample(ago(20 * MIN), { cpuPct: 12 }),
      sample(ago(5 * MIN), { cpuPct: 88 }),
    ])
    const last = await latestSample(ctx, nodeId)
    assert.equal(last?.cpuPct, 88)
  })

  test('is null for a node that never reported', async () => {
    assert.equal(await latestSample(ctx, nodeId), null)
  })
})

import { and, eq, gte, lte, sql, desc } from 'drizzle-orm'
import { nodeSamples } from '../db/schema.js'
import type { AppContext } from '../api/context.js'

/**
 * Telemetry history.
 *
 * A heartbeat arrives every few seconds and lives in Redis under a TTL. Keeping
 * every one of those forever would be 260,000 rows per node per month for data
 * nobody reads at that resolution — so samples are written at full rate for an
 * hour, then rolled up into minutes, then hours, and the finer grain deleted.
 *
 * The roll-up carries min and max alongside the mean. It used to average only,
 * which meant a CPU spike to 100% lasting twenty seconds became roughly 17% at
 * minute grain and nothing at hour grain: the mean answers "how busy on
 * average" and silently destroys the answer to "did it ever run out".
 */

export type Grain = 'fine' | 'minute' | 'hour'

/** How long each grain survives before it is rolled up and dropped. */
export const RETAIN_MS: Record<Grain, number> = {
  fine: 60 * 60_000, // an hour of 10s samples
  minute: 24 * 60 * 60_000, // a day of 1m aggregates
  hour: 30 * 24 * 60 * 60_000, // a month of 1h aggregates
}

export type Sample = {
  nodeId: string
  at: Date
  cpuPct: number | null
  ramUsedMb: number | null
  diskUsedMb: number | null
  diskTotalMb: number | null
  containers: number | null
  netRxKbps?: number | null
  netTxKbps?: number | null
  load1?: number | null
  tempC?: number | null
  swapUsedMb?: number | null
  dockerOk?: boolean | null
}

/**
 * Write one reading per node.
 *
 * Timestamps are floored to ten seconds. Heartbeats do not arrive on a tidy
 * cadence, and without flooring two beats a few milliseconds apart become two
 * rows that a chart draws as a spike. It also makes the write idempotent: a
 * retried heartbeat updates its bucket instead of duplicating it.
 *
 * min and max are seeded from the sample itself — at fine grain the reading is
 * its own peak, and seeding here is what lets the roll-up simply take max of
 * maxima without special-casing the first fold.
 */
export async function recordSamples(ctx: AppContext, samples: Sample[]): Promise<number> {
  if (!samples.length) return 0

  const rows = samples.map((s) => ({
    nodeId: s.nodeId,
    at: new Date(Math.floor(s.at.getTime() / 10_000) * 10_000),
    cpuPct: s.cpuPct,
    cpuMax: s.cpuPct,
    cpuMin: s.cpuPct,
    ramUsedMb: s.ramUsedMb,
    ramMaxMb: s.ramUsedMb,
    diskUsedMb: s.diskUsedMb,
    diskTotalMb: s.diskTotalMb,
    containers: s.containers,
    netRxKbps: s.netRxKbps ?? null,
    netTxKbps: s.netTxKbps ?? null,
    load1: s.load1 ?? null,
    tempC: s.tempC ?? null,
    swapUsedMb: s.swapUsedMb ?? null,
    dockerOk: s.dockerOk ?? null,
    grain: 'fine' as const,
  }))

  await ctx.db
    .insert(nodeSamples)
    .values(rows)
    .onConflictDoUpdate({
      target: [nodeSamples.nodeId, nodeSamples.at, nodeSamples.grain],
      set: {
        cpuPct: sql`excluded.cpu_pct`,
        cpuMax: sql`greatest(${nodeSamples.cpuMax}, excluded.cpu_max)`,
        cpuMin: sql`least(${nodeSamples.cpuMin}, excluded.cpu_min)`,
        ramUsedMb: sql`excluded.ram_used_mb`,
        ramMaxMb: sql`greatest(${nodeSamples.ramMaxMb}, excluded.ram_max_mb)`,
        diskUsedMb: sql`excluded.disk_used_mb`,
        diskTotalMb: sql`excluded.disk_total_mb`,
        containers: sql`excluded.containers`,
        netRxKbps: sql`excluded.net_rx_kbps`,
        netTxKbps: sql`excluded.net_tx_kbps`,
        load1: sql`excluded.load1`,
        tempC: sql`excluded.temp_c`,
        swapUsedMb: sql`excluded.swap_used_mb`,
        dockerOk: sql`excluded.docker_ok`,
      },
    })

  return rows.length
}

/**
 * Roll one grain up into the next and delete what was consumed.
 *
 * Means for rates, extremes for peaks, and the last value for levels. Disk is a
 * level: averaging an hour of it understates how full the disk is now, which is
 * the number someone acts on. `coalesce` on the peak columns covers rows
 * written before those columns existed.
 */
async function rollUp(ctx: AppContext, from: Grain, to: Grain, bucket: string): Promise<number> {
  const cutoff = new Date(Date.now() - RETAIN_MS[from])

  // The bucket is computed once, in a subquery, rather than repeated in both
  // the SELECT and the GROUP BY. Repeating it emits two different bind
  // placeholders, and Postgres compares those expressions syntactically: two
  // parameters carrying the same value are not the same expression, so it
  // refuses the group with "at must appear in the GROUP BY clause".
  const inserted = await ctx.db.execute(sql`
    insert into node_samples (
      node_id, at, cpu_pct, cpu_max, cpu_min, ram_used_mb, ram_max_mb,
      disk_used_mb, disk_total_mb, containers,
      net_rx_kbps, net_tx_kbps, load1, temp_c, swap_used_mb, docker_ok, grain
    )
    select
      node_id,
      bucket_at,
      avg(cpu_pct)::real,
      -- max of maxima is still the true peak, however many times it is folded
      max(coalesce(cpu_max, cpu_pct))::real,
      min(coalesce(cpu_min, cpu_pct))::real,
      avg(ram_used_mb)::int,
      max(coalesce(ram_max_mb, ram_used_mb))::int,
      (array_agg(disk_used_mb order by at desc))[1],
      (array_agg(disk_total_mb order by at desc))[1],
      (array_agg(containers order by at desc))[1],
      avg(net_rx_kbps)::int,
      avg(net_tx_kbps)::int,
      avg(load1)::real,
      max(temp_c)::real,
      max(swap_used_mb)::int,
      -- false if Docker was down at any point in the window: a bucket that was
      -- healthy on average is not a bucket that was healthy.
      bool_and(coalesce(docker_ok, true)),
      ${to}
    from (
      select
        node_id, at,
        date_trunc(${bucket}, at) as bucket_at,
        cpu_pct, cpu_max, cpu_min, ram_used_mb, ram_max_mb,
        disk_used_mb, disk_total_mb, containers,
        net_rx_kbps, net_tx_kbps, load1, temp_c, swap_used_mb, docker_ok
      from node_samples
      -- ISO string with an explicit cast: the driver will not bind a Date
      -- object into raw SQL, only into the query builder.
      where grain = ${from} and at < ${cutoff.toISOString()}::timestamptz
    ) rows
    group by node_id, bucket_at
    on conflict (node_id, at, grain) do nothing
  `)

  await ctx.db
    .delete(nodeSamples)
    .where(and(eq(nodeSamples.grain, from), lte(nodeSamples.at, cutoff)))

  return (inserted as unknown as { count?: number }).count ?? 0
}

/** Compact the table. Safe to call repeatedly; does nothing when nothing is due. */
export async function compactSamples(
  ctx: AppContext,
  log?: { info: (o: unknown, m: string) => void }
): Promise<{ toMinute: number; toHour: number; dropped: number }> {
  const toMinute = await rollUp(ctx, 'fine', 'minute', 'minute')
  const toHour = await rollUp(ctx, 'minute', 'hour', 'hour')

  const dropped = await ctx.db
    .delete(nodeSamples)
    .where(
      and(eq(nodeSamples.grain, 'hour'), lte(nodeSamples.at, new Date(Date.now() - RETAIN_MS.hour)))
    )
    .returning({ nodeId: nodeSamples.nodeId })

  const result = { toMinute, toHour, dropped: dropped.length }
  if (toMinute || toHour || dropped.length) log?.info(result, 'telemetry compacted')
  return result
}

/** Pick the finest grain that still covers the requested window. */
export function grainFor(sinceMs: number): Grain {
  if (sinceMs <= RETAIN_MS.fine) return 'fine'
  if (sinceMs <= RETAIN_MS.minute) return 'minute'
  return 'hour'
}

export type Point = {
  at: Date
  cpuPct: number | null
  cpuMax: number | null
  cpuMin: number | null
  ramUsedMb: number | null
  ramMaxMb: number | null
  diskUsedMb: number | null
  diskTotalMb: number | null
  containers: number | null
  netRxKbps: number | null
  netTxKbps: number | null
  load1: number | null
  tempC: number | null
  swapUsedMb: number | null
  dockerOk: boolean | null
}

/**
 * Read a window of history for one node, oldest first — the order a chart
 * draws in, so the browser never has to reverse a few hundred rows.
 */
export async function samplesFor(
  ctx: AppContext,
  nodeId: string,
  sinceMs: number
): Promise<Point[]> {
  const grain = grainFor(sinceMs)
  const since = new Date(Date.now() - sinceMs)

  return ctx.db
    .select({
      at: nodeSamples.at,
      cpuPct: nodeSamples.cpuPct,
      cpuMax: nodeSamples.cpuMax,
      cpuMin: nodeSamples.cpuMin,
      ramUsedMb: nodeSamples.ramUsedMb,
      ramMaxMb: nodeSamples.ramMaxMb,
      diskUsedMb: nodeSamples.diskUsedMb,
      diskTotalMb: nodeSamples.diskTotalMb,
      containers: nodeSamples.containers,
      netRxKbps: nodeSamples.netRxKbps,
      netTxKbps: nodeSamples.netTxKbps,
      load1: nodeSamples.load1,
      tempC: nodeSamples.tempC,
      swapUsedMb: nodeSamples.swapUsedMb,
      dockerOk: nodeSamples.dockerOk,
    })
    .from(nodeSamples)
    .where(
      and(eq(nodeSamples.nodeId, nodeId), eq(nodeSamples.grain, grain), gte(nodeSamples.at, since))
    )
    .orderBy(nodeSamples.at)
}

export type Peaks = {
  cpuMax: number | null
  cpuAvg: number | null
  ramMaxMb: number | null
  ramAvgMb: number | null
  netRxMax: number | null
  netTxMax: number | null
  tempMax: number | null
  load1Max: number | null
  samples: number
  /** Fraction of buckets in the window that reported at all. */
  coverage: number | null
}

/**
 * The summary above the charts.
 *
 * Computed in the database rather than over the returned points, because the
 * window may be a month of hourly rows and the peak is one number. Sending 720
 * rows to the browser to find a maximum it could have been told is work nobody
 * needs to do.
 */
export async function peaksFor(ctx: AppContext, nodeId: string, sinceMs: number): Promise<Peaks> {
  const grain = grainFor(sinceMs)
  const since = new Date(Date.now() - sinceMs)

  const [row] = await ctx.db
    .select({
      cpuMax: sql<number | null>`max(coalesce(${nodeSamples.cpuMax}, ${nodeSamples.cpuPct}))`,
      cpuAvg: sql<number | null>`avg(${nodeSamples.cpuPct})`,
      ramMaxMb: sql<number | null>`max(coalesce(${nodeSamples.ramMaxMb}, ${nodeSamples.ramUsedMb}))`,
      ramAvgMb: sql<number | null>`avg(${nodeSamples.ramUsedMb})`,
      netRxMax: sql<number | null>`max(${nodeSamples.netRxKbps})`,
      netTxMax: sql<number | null>`max(${nodeSamples.netTxKbps})`,
      tempMax: sql<number | null>`max(${nodeSamples.tempC})`,
      load1Max: sql<number | null>`max(${nodeSamples.load1})`,
      samples: sql<number>`count(*)::int`,
    })
    .from(nodeSamples)
    .where(
      and(eq(nodeSamples.nodeId, nodeId), eq(nodeSamples.grain, grain), gte(nodeSamples.at, since))
    )

  // How much of the window actually has data. A node that reported for ten
  // minutes of a six-hour window should not present its ten minutes as if they
  // described the whole afternoon.
  const bucketMs = grain === 'fine' ? 10_000 : grain === 'minute' ? 60_000 : 3_600_000
  const expected = Math.max(1, Math.round(sinceMs / bucketMs))

  return {
    cpuMax: row?.cpuMax ?? null,
    cpuAvg: row?.cpuAvg ?? null,
    ramMaxMb: row?.ramMaxMb ?? null,
    ramAvgMb: row?.ramAvgMb ?? null,
    netRxMax: row?.netRxMax ?? null,
    netTxMax: row?.netTxMax ?? null,
    tempMax: row?.tempMax ?? null,
    load1Max: row?.load1Max ?? null,
    samples: row?.samples ?? 0,
    coverage: row?.samples ? Math.min(1, row.samples / expected) : 0,
  }
}

/** The most recent sample for a node, whatever grain it survives at. */
export async function latestSample(ctx: AppContext, nodeId: string) {
  const [row] = await ctx.db
    .select()
    .from(nodeSamples)
    .where(eq(nodeSamples.nodeId, nodeId))
    .orderBy(desc(nodeSamples.at))
    .limit(1)
  return row ?? null
}

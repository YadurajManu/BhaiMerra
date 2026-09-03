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
 * The shape of the retention is the whole design: recent history is what you
 * need when something is on fire, and old history is only ever read as a trend.
 */

export type Grain = 'fine' | 'minute' | 'hour'

/** How long each grain survives before it is rolled up and dropped. */
export const RETAIN_MS: Record<Grain, number> = {
  fine: 60 * 60_000, // an hour of 10s samples
  minute: 24 * 60 * 60_000, // a day of 1m averages
  hour: 30 * 24 * 60 * 60_000, // a month of 1h averages
}

export type Sample = {
  nodeId: string
  at: Date
  cpuPct: number | null
  ramUsedMb: number | null
  diskUsedMb: number | null
  diskTotalMb: number | null
  containers: number | null
}

/**
 * Write one reading per node.
 *
 * Timestamps are floored to ten seconds. Heartbeats do not arrive on a tidy
 * cadence, and without flooring two beats a few milliseconds apart become two
 * rows that a chart draws as a spike. It also makes the write idempotent: a
 * retried heartbeat updates its bucket instead of duplicating it.
 */
export async function recordSamples(ctx: AppContext, samples: Sample[]): Promise<number> {
  if (!samples.length) return 0

  const rows = samples.map((s) => ({
    nodeId: s.nodeId,
    at: new Date(Math.floor(s.at.getTime() / 10_000) * 10_000),
    cpuPct: s.cpuPct,
    ramUsedMb: s.ramUsedMb,
    diskUsedMb: s.diskUsedMb,
    diskTotalMb: s.diskTotalMb,
    containers: s.containers,
    grain: 'fine' as const,
  }))

  await ctx.db
    .insert(nodeSamples)
    .values(rows)
    .onConflictDoUpdate({
      target: [nodeSamples.nodeId, nodeSamples.at, nodeSamples.grain],
      set: {
        cpuPct: sql`excluded.cpu_pct`,
        ramUsedMb: sql`excluded.ram_used_mb`,
        diskUsedMb: sql`excluded.disk_used_mb`,
        diskTotalMb: sql`excluded.disk_total_mb`,
        containers: sql`excluded.containers`,
      },
    })

  return rows.length
}

/**
 * Roll one grain up into the next and delete what was consumed.
 *
 * Averages CPU and RAM because a mean is what a trend line wants; takes the
 * last disk figure rather than the mean, because disk is a level and averaging
 * it across an hour understates how full the disk is right now.
 */
async function rollUp(ctx: AppContext, from: Grain, to: Grain, bucket: string): Promise<number> {
  const cutoff = new Date(Date.now() - RETAIN_MS[from])

  // The bucket is computed once, in a subquery, rather than repeated in both
  // the SELECT and the GROUP BY. Repeating it emits two different bind
  // placeholders, and Postgres compares those expressions syntactically: two
  // parameters carrying the same value are not the same expression, so it
  // refuses the group with "at must appear in the GROUP BY clause".
  const inserted = await ctx.db.execute(sql`
    insert into node_samples (node_id, at, cpu_pct, ram_used_mb, disk_used_mb, disk_total_mb, containers, grain)
    select
      node_id,
      bucket_at,
      avg(cpu_pct)::real,
      avg(ram_used_mb)::int,
      -- Disk is a level, not a rate. Averaging an hour of it understates how
      -- full the disk is now, which is the number someone acts on.
      (array_agg(disk_used_mb order by at desc))[1],
      (array_agg(disk_total_mb order by at desc))[1],
      (array_agg(containers order by at desc))[1],
      ${to}
    from (
      select
        node_id,
        at,
        date_trunc(${bucket}, at) as bucket_at,
        cpu_pct,
        ram_used_mb,
        disk_used_mb,
        disk_total_mb,
        containers
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

/**
 * Compact the table. Safe to call repeatedly; does nothing when nothing is due.
 *
 * Runs on the sweeper's clock rather than the hourly janitor because fine-grain
 * rows accumulate at heartbeat rate, and an hour of unbounded growth across a
 * large fleet is a lot of rows to leave lying around.
 */
export async function compactSamples(
  ctx: AppContext,
  log?: { info: (o: unknown, m: string) => void }
): Promise<{ toMinute: number; toHour: number; dropped: number }> {
  const toMinute = await rollUp(ctx, 'fine', 'minute', 'minute')
  const toHour = await rollUp(ctx, 'minute', 'hour', 'hour')

  // Anything past the coarsest retention is simply gone. Keeping a year of
  // hourly points for a homelab is storage nobody asked for.
  const dropped = await ctx.db
    .delete(nodeSamples)
    .where(
      and(
        eq(nodeSamples.grain, 'hour'),
        lte(nodeSamples.at, new Date(Date.now() - RETAIN_MS.hour))
      )
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

/**
 * Read a window of history for one node, oldest first.
 *
 * Oldest first because that is the order a chart draws in, and reversing a few
 * hundred rows in the browser is work the database can simply not create.
 */
export async function samplesFor(
  ctx: AppContext,
  nodeId: string,
  sinceMs: number
): Promise<Array<Omit<Sample, 'nodeId'>>> {
  const grain = grainFor(sinceMs)
  const since = new Date(Date.now() - sinceMs)

  const rows = await ctx.db
    .select({
      at: nodeSamples.at,
      cpuPct: nodeSamples.cpuPct,
      ramUsedMb: nodeSamples.ramUsedMb,
      diskUsedMb: nodeSamples.diskUsedMb,
      diskTotalMb: nodeSamples.diskTotalMb,
      containers: nodeSamples.containers,
    })
    .from(nodeSamples)
    .where(
      and(eq(nodeSamples.nodeId, nodeId), eq(nodeSamples.grain, grain), gte(nodeSamples.at, since))
    )
    .orderBy(nodeSamples.at)

  return rows
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

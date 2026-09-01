import { and, desc, eq, inArray, isNotNull } from 'drizzle-orm'
import { backups, services } from '../db/schema.js'
import { requestBackup } from './store.js'
import type { AppContext } from '../api/context.js'

/**
 * Backups nobody has to remember to take.
 *
 * A backup you have to ask for is a backup that gets taken twice and then
 * forgotten, which is the same as no backup at all on the day it matters. The
 * manifest says how often, and this makes it so.
 */

/** How long between scheduled backups, by name. */
const INTERVALS: Record<string, number> = {
  hourly: 60 * 60_000,
  daily: 24 * 60 * 60_000,
  weekly: 7 * 24 * 60 * 60_000,
}

export const SCHEDULES = Object.keys(INTERVALS)

export function intervalFor(schedule: string): number | null {
  return INTERVALS[schedule.trim().toLowerCase()] ?? null
}

/**
 * Take any scheduled backup that is due.
 *
 * Due is measured from the last *attempt*, not the last success. Measuring
 * from success means a service whose backups are failing gets retried on every
 * sweep — a tight loop of failing tar processes on a machine that is also
 * serving, which turns one broken volume into a performance problem.
 */
export async function runDueBackups(
  ctx: AppContext,
  opts: { log?: { info: (o: unknown, m: string) => void }; now?: number } = {}
): Promise<string[]> {
  const now = opts.now ?? Date.now()
  const scheduled = await ctx.db
    .select()
    .from(services)
    .where(and(isNotNull(services.backupSchedule), eq(services.persistentVolume, true)))

  const taken: string[] = []

  for (const service of scheduled) {
    const interval = intervalFor(service.backupSchedule ?? '')
    if (!interval) continue

    const [last] = await ctx.db
      .select({ createdAt: backups.createdAt })
      .from(backups)
      .where(eq(backups.serviceId, service.id))
      .orderBy(desc(backups.createdAt))
      .limit(1)

    if (last && now - last.createdAt.getTime() < interval) continue

    try {
      const row = await requestBackup(ctx, service, { scheduled: true })
      taken.push(row.id)
      opts.log?.info(
        { service: service.name, schedule: service.backupSchedule, backup: row.id },
        'scheduled backup queued'
      )
    } catch {
      // Every refusal here is a legitimate state rather than a fault: the
      // service is not running, or a backup is already in flight. The next
      // sweep tries again, and an alert on each would be noise.
    }
  }

  return taken
}

/** Backups past their keep count, oldest first. */
export async function pruneOldBackups(
  ctx: AppContext,
  keep = 7
): Promise<string[]> {
  const withSchedule = await ctx.db
    .select({ id: services.id })
    .from(services)
    .where(isNotNull(services.backupSchedule))

  const removed: string[] = []
  for (const service of withSchedule) {
    const rows = await ctx.db
      .select({ id: backups.id })
      .from(backups)
      .where(and(eq(backups.serviceId, service.id), eq(backups.status, 'complete')))
      .orderBy(desc(backups.createdAt))

    // Only complete ones count towards the limit, so a run of failures never
    // silently evicts the last good archive.
    const excess = rows.slice(keep)
    if (!excess.length) continue

    const { deleteBackup } = await import('./store.js')
    for (const row of excess) {
      const [full] = await ctx.db.select().from(backups).where(eq(backups.id, row.id)).limit(1)
      if (full) {
        await deleteBackup(ctx, full)
        removed.push(full.id)
      }
    }
  }
  return removed
}

/** Statuses that mean a backup is still in flight. Shared with the sweeper. */
export const IN_FLIGHT = ['pending', 'running'] as const
export const inFlight = inArray(backups.status, [...IN_FLIGHT])

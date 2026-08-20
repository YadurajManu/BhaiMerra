import { and, eq, inArray, ne } from 'drizzle-orm'
import { fleets, nodes } from '../db/schema.js'
import type { RescheduleOutcome } from '../scheduler/reschedule.js'
import { rescheduleFromNode } from '../scheduler/reschedule.js'
import type { AppContext } from '../api/context.js'
import type { FleetEventPayload } from '../lib/events.js'

export type Sweeper = { stop: () => void }

export type SweepOptions = {
  onEvent?: (event: FleetEventPayload) => void | Promise<void>
  log?: { info: (o: unknown, m: string) => void; error: (o: unknown, m: string) => void }
}

export type SweepResult = {
  markedDown: Array<{ id: string; name: string; fleetId: string }>
  /** What the scheduler did about it, per service (FR-6/FR-7). */
  rescheduled: Array<{ nodeId: string; outcomes: RescheduleOutcome[] }>
}

/**
 * Failure detection (FR-5). Runs on a tick and asks Redis which nodes in each
 * fleet have gone quiet — a pull, not a subscription to expiry events, so a
 * control plane that was restarting when a key expired still notices.
 *
 * Only state *transitions* are written to Postgres. A node that is already
 * marked offline costs nothing to keep sweeping.
 */
/**
 * One full detection pass. Exported separately from the interval so tests can
 * drive it deterministically instead of waiting on a timer.
 */
export async function sweepOnce(ctx: AppContext, opts: SweepOptions = {}): Promise<SweepResult> {
  const markedDown: SweepResult['markedDown'] = []
  const rescheduled: SweepResult['rescheduled'] = []
  {
    {
      const allFleets = await ctx.db
        .select({
          id: fleets.id,
          intervalSec: fleets.heartbeatIntervalSec,
          threshold: fleets.heartbeatMissThreshold,
        })
        .from(fleets)

      for (const fleet of allFleets) {
        const stale = await ctx.heartbeats.staleNodes(fleet.id, {
          intervalSec: fleet.intervalSec,
          threshold: fleet.threshold,
        })
        if (!stale.length) continue

        // Cordoned nodes are excluded deliberately: the operator has already
        // said they know about that node, and re-alerting is noise.
        const transitioned = await ctx.db
          .update(nodes)
          .set({ status: 'offline' })
          .where(
            and(
              eq(nodes.fleetId, fleet.id),
              inArray(nodes.id, stale),
              ne(nodes.status, 'offline'),
              ne(nodes.status, 'cordoned')
            )
          )
          .returning({ id: nodes.id, name: nodes.name })

        for (const node of transitioned) {
          // Marker read by the heartbeat route so recovery is immediate.
          await ctx.redis.set(`node:${node.id}:down`, '1', 'EX', 24 * 60 * 60)
          markedDown.push({ ...node, fleetId: fleet.id })
          opts.log?.info({ nodeId: node.id, name: node.name }, 'node marked down')
          await opts.onEvent?.({
            type: 'node.down',
            fleetId: fleet.id,
            at: new Date().toISOString(),
            subject: node.name,
            detail: {
              missedThreshold: fleet.threshold,
              intervalSec: fleet.intervalSec,
              silentForMs: ctx.heartbeats.downAfterMs(fleet.intervalSec, fleet.threshold),
            },
          })

          // Detection is only half of it. Move what can be moved (FR-6) and
          // raise a distinct alert for what must not be (FR-7).
          try {
            const outcomes = await rescheduleFromNode(ctx, fleet.id, node.id, {
              onEvent: opts.onEvent,
            })
            if (outcomes.length) {
              rescheduled.push({ nodeId: node.id, outcomes })
              opts.log?.info(
                { nodeId: node.id, node: node.name, outcomes },
                'rescheduled workloads from downed node'
              )
            }
          } catch (err) {
            // A failed reschedule must not abort the sweep: other nodes in
            // other fleets still need to be detected.
            opts.log?.error({ err, nodeId: node.id }, 'reschedule failed after node went down')
          }
        }
      }
    }
  }
  return { markedDown, rescheduled }
}

export function startSweeper(
  ctx: AppContext,
  opts: SweepOptions & { tickMs?: number } = {}
): Sweeper {
  const tickMs = opts.tickMs ?? Math.max(1000, ctx.config.HEARTBEAT_INTERVAL_SEC * 1000)
  let running = false
  let stopped = false

  const tick = async () => {
    if (running || stopped) return // never overlap a slow sweep with the next one
    running = true
    try {
      await sweepOnce(ctx, opts)
    } catch (err) {
      opts.log?.error({ err }, 'sweeper tick failed')
    } finally {
      running = false
    }
  }

  const timer = setInterval(tick, tickMs)
  // Never hold the process open for a background job.
  if (typeof timer.unref === 'function') timer.unref()
  void tick()

  return {
    stop: () => {
      stopped = true
      clearInterval(timer)
    },
  }
}

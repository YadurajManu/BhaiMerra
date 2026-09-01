import { and, eq, inArray, lt, ne } from 'drizzle-orm'
import { deployments, fleets, nodes } from '../db/schema.js'
import type { RescheduleOutcome } from '../scheduler/reschedule.js'
import { rescheduleFromNode } from '../scheduler/reschedule.js'
import { reconcileReplicas, type ScaleOutcome } from '../scheduler/replicas.js'
import { failStalledBackups } from '../backup/store.js'
import { invalidateRoutesForService } from '../ingress/routes.js'
import type { AppContext } from '../api/context.js'
import type { FleetEventPayload } from '../lib/events.js'

export type Sweeper = { stop: () => void }

export type SweepOptions = {
  onEvent?: (event: FleetEventPayload) => void | Promise<void>
  log?: {
    info: (o: unknown, m: string) => void
    warn?: (o: unknown, m: string) => void
    error: (o: unknown, m: string) => void
  }
}

export type SweepResult = {
  markedDown: Array<{ id: string; name: string; fleetId: string }>
  /** What the scheduler did about it, per service (FR-6/FR-7). */
  rescheduled: Array<{ nodeId: string; outcomes: RescheduleOutcome[] }>
  /** Builds whose control plane died underneath them (see failStaleBuilds). */
  abandonedBuilds: string[]
  /** Replica counts brought back in line with what the manifest asked for. */
  scaled: ScaleOutcome[]
}

/** Phases a deployment only passes through, never rests in. */
const PRE_DEPLOY_PHASES = ['queued', 'building', 'pushing', 'scheduling'] as const

/**
 * A deploy in a pre-`deploying` phase is being actively worked on by whichever
 * request opened it. If the control plane restarts mid-build, nothing is left to
 * finish or fail it, and the row reads `building` forever — worse than the old
 * behaviour of leaving no row at all, because it looks like progress.
 *
 * The cutoff is the build timeout plus slack, so a legitimately slow build is
 * never cut short: by the time this fires, the process that owned the row has
 * either given up or is gone.
 */
export async function failStaleBuilds(ctx: AppContext, opts: SweepOptions = {}): Promise<string[]> {
  const cutoff = new Date(Date.now() - (ctx.config.BUILD_TIMEOUT_MS + 60_000))

  const stale = await ctx.db
    .update(deployments)
    .set({
      status: 'failed',
      failureReason: 'the control plane restarted while this was building',
      finishedAt: new Date(),
    })
    .where(
      and(
        inArray(deployments.status, [...PRE_DEPLOY_PHASES]),
        lt(deployments.startedAt, cutoff)
      )
    )
    .returning({ id: deployments.id })

  for (const row of stale) {
    // The volatile progress line has nothing left to describe.
    await ctx.redis.del(`deploy:progress:${row.id}`).catch(() => {})
    opts.log?.info({ deploymentId: row.id }, 'failed abandoned build')
  }
  return stale.map((row) => row.id)
}

/**
 * How long a deployment may sit in `deploying` before it is declared a failure.
 *
 * This is the window in which a container has to be pulled, started, and report
 * healthy. Generous, because a first pull of a large image over a domestic
 * connection is genuinely slow, and cutting a working rollout short is worse
 * than waiting a few more minutes for one that was never going to finish.
 */
export const ROLLOUT_TIMEOUT_MS = 10 * 60_000

/**
 * A rollout that never became healthy.
 *
 * The previous release is deliberately left alone. That is the whole point of
 * the change this belongs to: a deployment stays `deploying` until the node
 * reports the container healthy, so a broken image simply never gets promoted,
 * and the release that works keeps serving. All that is left to do is stop
 * waiting and record why.
 *
 * Rows whose service has no other live deployment are failed too — there is
 * nothing to fall back to, but a row stuck in `deploying` forever is a worse
 * answer than a failed one that says what happened.
 */
export async function failStalledRollouts(
  ctx: AppContext,
  opts: SweepOptions = {}
): Promise<string[]> {
  const cutoff = new Date(Date.now() - ROLLOUT_TIMEOUT_MS)

  // Candidates first, so each one can be checked against what its node is
  // reporting *right now* before anything is written.
  //
  // This used to be a single UPDATE, and it tore down services that were
  // serving traffic. A deployment is only promoted out of `deploying` on a
  // heartbeat carrying its container, so anything that stops that heartbeat
  // arriving — a failed `docker ps` on the node, a control plane that was
  // down while the window elapsed — leaves a perfectly healthy container in
  // `deploying` until this ran and killed it. Timing out is a claim about the
  // container, and the node is the only thing that can support it.
  const candidates = await ctx.db
    .select({
      id: deployments.id,
      serviceId: deployments.serviceId,
      nodeId: deployments.nodeId,
    })
    .from(deployments)
    .where(and(eq(deployments.status, 'deploying'), lt(deployments.startedAt, cutoff)))

  if (!candidates.length) return []

  // One heartbeat read per node, not per deployment.
  const nodeIds = [...new Set(candidates.map((c) => c.nodeId).filter((id): id is string => Boolean(id)))]
  const beats = new Map(
    await Promise.all(
      nodeIds.map(async (id) => [id, await ctx.heartbeats.last(id).catch(() => null)] as const)
    )
  )

  const failed: string[] = []
  const rescued: string[] = []

  for (const row of candidates) {
    const beat = row.nodeId ? beats.get(row.nodeId) : null
    const container = beat?.containers?.find((c) => c.deployment_id === row.id)

    if (container && container.state === 'running') {
      // It is up. The rollout did not stall, the promotion signal did — so
      // promote it here rather than destroying what is already working.
      await ctx.db
        .update(deployments)
        .set({ status: 'running', finishedAt: new Date() })
        .where(eq(deployments.id, row.id))
      rescued.push(row.id)
      ;(opts.log?.warn ?? opts.log?.info)?.(
        { deploymentId: row.id, nodeId: row.nodeId },
        'rollout window elapsed but the node reports this container running; promoted instead of failed'
      )
      continue
    }

    await ctx.db
      .update(deployments)
      .set({
        status: 'failed',
        failureReason: container
          ? `the container is ${container.state} and never reported healthy within the rollout window`
          : 'the node never reported this container within the rollout window; the previous release was left running',
        finishedAt: new Date(),
      })
      .where(eq(deployments.id, row.id))
    failed.push(row.id)
    opts.log?.info({ deploymentId: row.id }, 'failed a rollout that never became healthy')
  }

  // Routes are keyed on the live deployment; a rescued one has to become
  // reachable rather than merely look correct in the database.
  for (const id of rescued) {
    const row = candidates.find((c) => c.id === id)
    if (row) await invalidateRoutesForService(ctx, row.serviceId).catch(() => {})
  }

  return failed
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
  const scaled: ScaleOutcome[] = []
  const rescheduled: SweepResult['rescheduled'] = []

  // Independent of node health, and cheap: one indexed update. Runs first so a
  // reschedule triggered below never has to reason about a phantom build.
  let abandonedBuilds: string[] = []
  try {
    abandonedBuilds = await failStaleBuilds(ctx, opts)
  } catch (err) {
    opts.log?.error({ err }, 'stale build sweep failed')
  }
  try {
    abandonedBuilds = abandonedBuilds.concat(await failStalledRollouts(ctx, opts))
  } catch (err) {
    opts.log?.error({ err }, 'stalled rollout sweep failed')
  }
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
        const redisStale = await ctx.heartbeats.staleNodes(fleet.id, {
          intervalSec: fleet.intervalSec,
          threshold: fleet.threshold,
        })

        const cutoff = new Date(Date.now() - ctx.heartbeats.downAfterMs(fleet.intervalSec, fleet.threshold))

        // Cordoned nodes are excluded deliberately: the operator has already
        // said they know about that node, and re-alerting is noise.
        const dbOnlineNodes = await ctx.db
          .select({ id: nodes.id, lastHeartbeatAt: nodes.lastHeartbeatAt })
          .from(nodes)
          .where(
            and(
              eq(nodes.fleetId, fleet.id),
              ne(nodes.status, 'offline'),
              ne(nodes.status, 'cordoned')
            )
          )

        const dbStale = dbOnlineNodes
          // Redis is the live liveness source. A null persisted timestamp is
          // normal for a node that has only just registered or for test/legacy
          // rows; `markRegistered` puts those nodes in the Redis sorted set so
          // `redisStale` can make the decision without racing a fresh beat.
          // Only use Postgres as a restart-safe fallback once it has a real
          // heartbeat timestamp to compare.
          .filter((n) => Boolean(n.lastHeartbeatAt && n.lastHeartbeatAt < cutoff))
          .map((n) => n.id)

        const allStale = [...new Set([...redisStale, ...dbStale])]
        if (!allStale.length) continue

        const transitioned = await ctx.db
          .update(nodes)
          .set({ status: 'offline' })
          .where(
            and(
              eq(nodes.fleetId, fleet.id),
              inArray(nodes.id, allStale),
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
        // A backup whose node died mid-archive leaves its row `running`
        // forever, and the one-at-a-time rule then blocks every future backup
        // of that service — a stall that presents as "backups quietly stopped
        // working".
        try {
          const stalled = await failStalledBackups(ctx)
          for (const id of stalled) opts.log?.info({ backupId: id }, 'failed an abandoned backup')
        } catch (err) {
          opts.log?.error({ err }, 'backup stall sweep failed')
        }

        // Replica counts are desired state, so they are reconciled on the
        // same tick that notices a node has gone. A replica lost with its
        // node is replaced here rather than staying one short until somebody
        // deploys again.
        try {
          const scale = await reconcileReplicas(ctx, fleet.id, { log: opts.log })
          for (const outcome of scale) scaled.push(outcome)
        } catch (err) {
          // Scaling is an optimisation over a fleet that is already serving.
          // Failing the whole sweep — which is also what marks nodes down —
          // because a replica could not be placed would be a poor trade.
          opts.log?.error({ err, fleetId: fleet.id }, 'replica reconciliation failed')
        }
      }
    }
  }
  return { markedDown, rescheduled, abandonedBuilds, scaled }
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

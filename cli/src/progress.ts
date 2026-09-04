/**
 * Following a deploy.
 *
 * `POST /services/:id/deploy` is a single request that can take minutes: it builds
 * for every architecture in the fleet, pushes to the registry, allocates a port
 * and hands the container to an agent. The control plane now walks the deployment
 * row through those phases and publishes the build's own sub-step alongside it
 * (control-plane/src/api/deploy-progress.ts), so the CLI can poll for them while
 * it waits on the request it already has in flight, and show where the work has
 * actually got to instead of guessing.
 *
 * Progress is decoration, never the result: a poll that fails is swallowed and the
 * deploy carries on. Only `awaitRunning`, where a poll *is* the mechanism, treats
 * a persistently unreachable control plane as an error.
 */
import { request, CliError, EXIT } from './api.js'
import type { Ladder, Step } from './ladder.js'
import { bar } from './ui.js'

/** The shape of `GET /services/:id/progress`. Mirrors `DeployProgress` server-side. */
export type DeployProgress = {
  deploymentId: string
  status: string
  since: string
  gitSha: string | null
  nodeName: string | null
  failureReason: string | null
  /** The live build line, present only while a build is in flight. */
  detail?: string
  step?: number
  ofSteps?: number
  platform?: string
  /** This platform is being built under emulation, which is why it is slow. */
  emulated?: boolean
  /** Median of this service's own recent deploys. Absent on a first deploy. */
  typicalMs?: number
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** A failure reason can be a build log tail; a one-line error gets one line of it. */
export const firstLine = (text: string): string => text.split('\n')[0]!.trim().slice(0, 200)

export async function fetchProgress(serviceId: string): Promise<DeployProgress | null> {
  const { body } = await request<{ progress: DeployProgress | null }>(
    'GET',
    `/services/${serviceId}/progress`
  )
  return body.progress
}

/**
 * The build's sub-step as one line. `linux/arm64` is shortened because the arch is
 * the informative half and the redraw region is narrow.
 */
export function progressLine(p: DeployProgress): string | undefined {
  if (!p.detail) return undefined
  const counter = p.step && p.ofSteps ? `${p.step}/${p.ofSteps} ` : ''
  const platform = p.platform ? `${p.platform.replace(/^linux\//, '')} ` : ''
  // Emulation is the answer to "why is this taking so long", and a build that
  // takes three minutes instead of twenty seconds is almost always this. Said
  // once, on the line already being drawn, rather than as a separate warning.
  const how = p.emulated ? ' (emulated — slow)' : ''
  return `${counter}${platform}${p.detail}${how}`
}

/**
 * A duration a person reads, not a step suffix.
 *
 * ui.ts has `duration`, which is dim, colour-wrapped, prefixed with a space
 * and renders three minutes as "180s" — right for the end of a finished step,
 * wrong for a sentence about how long is left.
 */
function human(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  if (total < 60) return `${total}s`
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  if (minutes < 60) return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`
  const hours = Math.floor(minutes / 60)
  return `${hours}h ${minutes % 60}m`
}

/**
 * Elapsed against what this service usually takes.
 *
 * Only from real history: on a first deploy there is nothing honest to say,
 * and a bar filled from a number nobody measured is the same lie as the "not
 * needed" it replaces. Overrunning is shown as overrunning rather than parked
 * at the end of the bar — a deploy that is genuinely slow today is exactly
 * when somebody needs to know.
 */
export function etaLine(p: DeployProgress, now = Date.now()): string | undefined {
  if (!p.typicalMs || !p.since) return undefined
  const elapsed = now - new Date(p.since).getTime()
  if (elapsed < 0) return undefined

  const fraction = Math.min(1, elapsed / p.typicalMs)
  const left = p.typicalMs - elapsed
  const tail =
    left > 0
      ? `~${human(left)} left`
      : `${human(-left)} over the usual ${human(p.typicalMs)}`
  return `${bar(fraction)} ${human(elapsed)} · ${tail}`
}

/**
 * Poll `/progress` in the background while something else is being awaited.
 *
 * The shape is the device-flow race in auth.ts: the answer comes from one promise
 * while a second keeps the display honest until it lands. `stop()` interrupts the
 * sleep rather than waiting it out, so the last frame is not held back by a poll
 * interval that is no longer needed.
 */
export function follow(
  serviceId: string,
  sink: (p: DeployProgress) => void,
  opts: { intervalMs?: number; onUnavailable?: () => void } = {}
): { stop: () => Promise<void>; untilSettled: (o?: { deadlineMs?: number }) => Promise<void> } {
  const interval = opts.intervalMs ?? 800
  let stopped = false
  let misses = 0
  let wake: (() => void) | null = null
  /** Resolves once the deploy has left the phases this ladder draws. */
  let settled: () => void = () => {}
  const settledWhen = new Promise<void>((resolve) => {
    settled = resolve
  })

  const rest = (ms: number) =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms)
      wake = () => {
        clearTimeout(timer)
        resolve()
      }
    })

  const loop = (async () => {
    while (!stopped) {
      await rest(interval)
      if (stopped) return
      try {
        const progress = await fetchProgress(serviceId)
        misses = 0
        if (progress) {
          sink(progress)
          // `deploying` means the build and push are behind us and the node
          // has been told; everything after that is the rollout, which the
          // caller reports on separately.
          // `status` carries the phase: queued → building → pushing →
          // scheduling → deploying. Anything at or past `deploying` means the
          // build and push are behind us; the rest is the rollout, which the
          // caller reports on separately.
          if (progress.status === 'deploying' || progress.status === 'running') settled()
        } else {
          // No progress row at all means the build phases are over: the row is
          // dropped once a deploy leaves them, and a deploy that never wrote
          // one had nothing to build.
          settled()
        }
      } catch {
        // A control plane that predates the endpoint answers 404 every time, so
        // give up rather than spend the whole build asking again.
        if (++misses >= 3) {
          opts.onUnavailable?.()
          return
        }
      }
    }
  })()

  // The loop ending for any reason — including a control plane with no
  // progress endpoint — has to release anybody waiting, or a missing feature
  // becomes a hang.
  void loop.then(() => settled()).catch(() => settled())

  return {
    stop: async () => {
      stopped = true
      wake?.()
      await loop.catch(() => {})
    },
    /**
     * Wait until the build phases are done.
     *
     * Bounded: a deploy whose progress never arrives must not hold the ladder
     * open for ever. On the deadline this returns rather than throwing — the
     * caller's own wait is what decides whether the deploy failed, and two
     * things reporting the same failure is worse than one.
     */
    untilSettled: async ({ deadlineMs = 45 * 60_000 } = {}) => {
      let timer: NodeJS.Timeout | undefined
      await Promise.race([
        settledWhen,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, deadlineMs)
        }),
      ])
      if (timer) clearTimeout(timer)
    },
  }
}

/** Ladder steps for a deploy, in the order the control plane reports them. */
export const DEPLOY_STEPS: Step[] = [
  { key: 'place', label: 'choosing a node' },
  { key: 'build', label: 'building the image' },
  { key: 'push', label: 'pushing to the fleet registry' },
  { key: 'schedule', label: 'scheduling onto the node' },
  { key: 'health', label: 'waiting for the container' },
]

/** Which ladder step each server-reported phase corresponds to. */
const STEP_OF: Record<string, number> = {
  queued: 0,
  building: 1,
  pushing: 2,
  scheduling: 3,
  deploying: 4,
  running: 5,
}

export type PhaseWalker = {
  /** Apply a poll result. Only ever moves forward. */
  apply(p: DeployProgress): void
  /** Move to a step directly, for the phases learned from a response rather than a poll. */
  advance(target: number, summary?: string): void
  /** Settle everything that is left. */
  finish(summary?: string): void
  /** Index of the step currently in flight. */
  readonly at: number
}

/**
 * Drive a ladder from the server's phases.
 *
 * Forward only: a poll can arrive out of order, and re-beginning a step would
 * restart its clock. Steps the deploy never entered are marked skipped rather than
 * done — a service deployed from a prebuilt image goes straight from `queued` to
 * `scheduling`, and settling build and push as complete would claim work that
 * never happened.
 */
export function phaseWalker(l: Ladder, steps: Step[] = DEPLOY_STEPS): PhaseWalker {
  let at = 0
  l.begin(steps[0]!.key)

  const advance = (target: number, summary?: string) => {
    if (target <= at) return
    for (let i = at; i < target; i++) {
      if (i === at) l.done(steps[i]!.key, summary)
      else l.skip(steps[i]!.key, 'not needed')
    }
    at = target
    if (target < steps.length) l.begin(steps[target]!.key)
  }

  return {
    advance,
    finish: (summary) => advance(steps.length, summary),
    get at() {
      return at
    },

    apply(p) {
      if (p.status === 'failed') {
        l.failActive(p.failureReason ? firstLine(p.failureReason) : undefined)
        return
      }
      const target = STEP_OF[p.status]
      if (target !== undefined) {
        // Which node was chosen is the one summary worth carrying over from a
        // poll, and it belongs on the step that decided it.
        advance(target, at === 0 ? (p.nodeName ?? undefined) : undefined)
      }
      // The build line, or the estimate when there is no build line to show.
      //
      // Both on one row rather than two: the ladder redraws a fixed region and
      // a row that appears and disappears makes the whole block jump. During a
      // build the sub-step is the more useful of the two — it is proof of
      // movement — and the estimate carries the rest of the wait, when the
      // node is pulling an image and nothing is being logged at all.
      const line = progressLine(p) ?? etaLine(p)
      if (line && at < steps.length) l.detail(steps[at]!.key, line)
    },
  }
}

/**
 * Follow a service to `running`.
 *
 * The deploy request returns once the image exists and a node has been chosen; the
 * container actually starting is the agent's job and happens afterwards, so the
 * CLI follows it to a conclusion rather than reporting "scheduled" and leaving the
 * operator to guess. One indexed row per poll, not the whole service list.
 */
export async function awaitRunning(
  service: { id: string; name: string },
  opts: { timeoutMs?: number; onProgress?: (p: DeployProgress) => void } = {}
): Promise<void> {
  const deadline = Date.now() + (opts.timeoutMs ?? 180_000)
  let misses = 0

  while (Date.now() < deadline) {
    let progress: DeployProgress | null = null
    try {
      progress = await fetchProgress(service.id)
      misses = 0
    } catch (err) {
      // Here a poll is the mechanism, not decoration. Reporting a timeout when
      // the control plane simply stopped answering would blame the wrong thing.
      if (++misses >= 5) throw err
    }

    if (progress?.status === 'running') return
    if (progress?.status === 'failed') {
      const why = progress.failureReason ? `: ${firstLine(progress.failureReason)}` : ''
      throw new CliError(
        `"${service.name}" did not start${why}. \`fleet deployments ${service.name}\` has the detail.`,
        EXIT.healthCheckFailed
      )
    }
    if (progress?.status === 'pinned_unavailable') {
      throw new CliError(
        `"${service.name}" is pinned to a node that is not available. ` +
          `\`fleet where ${service.name}\` explains why.`,
        EXIT.noEligibleNode
      )
    }
    if (progress) opts.onProgress?.(progress)

    await sleep(2000)
  }

  throw new CliError(
    `"${service.name}" was scheduled but has not reported running. ` +
      `\`fleet deployments ${service.name}\` has the detail.`,
    EXIT.healthCheckFailed
  )
}

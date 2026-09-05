/**
 * Deploy progress.
 *
 * `deployment_status` has modelled `queued → building → pushing → scheduling →
 * deploying` since the schema was written, and nothing ever wrote the first
 * four: every insert jumped straight to `deploying`. Two consequences the CLI
 * could not work around. A four-minute multi-arch build was one opaque POST, so
 * the loading animation had nothing true to say. And a build that failed threw
 * before any row was inserted, so `fleet deployments web` showed nothing at all
 * about the failure that had just happened.
 *
 * Two stores, deliberately:
 *
 *   - Postgres holds the coarse phase. It is durable history, and it belongs on
 *     the row that a later rollback reads.
 *   - Redis holds the volatile line underneath — which layer, which platform —
 *     as a single last value with a short TTL. A build emits thousands of those
 *     and none of them are history.
 *
 * Rows in the pre-`deploying` phases are invisible to every consumer of
 * deployment status: agent desired state matches `deploying`, ingress routing
 * and the scheduler's RAM accounting match `['deploying','running']`. So a row
 * can exist, and be reported on, for the whole length of a build without any
 * node being told to pull an image that does not exist yet.
 */
import { and, desc, eq, inArray, isNotNull, ne } from 'drizzle-orm'
import { deployments, nodes } from '../db/schema.js'
import type { BuildProgress } from '../build/runner.js'
import type { AppContext } from './context.js'

/** The phases a deployment passes through on its way to a node. */
export type DeployPhase = 'queued' | 'building' | 'pushing' | 'scheduling' | 'deploying'

/** Phases only ever advance; an out-of-order write is dropped, not applied. */
const ORDER: DeployPhase[] = ['queued', 'building', 'pushing', 'scheduling', 'deploying']

/** Phases during which the volatile Redis line is meaningful. */
const BUILD_PHASES = new Set<string>(['queued', 'building', 'pushing'])

const lineKey = (deploymentId: string) => `deploy:progress:${deploymentId}`

/**
 * Long enough to survive a slow layer, short enough that an abandoned build's
 * last line does not outlive any interest in it.
 */
const LINE_TTL_SEC = 120

/** At most four writes a second. This is a progress line, not a log store. */
const LINE_MIN_INTERVAL_MS = 250

/** A build log tail is worth keeping on the row, but not without a bound. */
const MAX_REASON = 4000

/**
 * A failure reason is read back out through the CLI, which now redraws in
 * place — an escape sequence from a build log would corrupt the region. Newline
 * and tab survive because the reason is a log tail and its shape is the point.
 */
export const cleanReason = (text: string): string =>
  [...text]
    .map((ch) => {
      const code = ch.codePointAt(0)!
      if (ch === '\n' || ch === '\t') return ch
      return code < 0x20 || code === 0x7f ? ' ' : ch
    })
    .join('')
    .trim()
    .slice(0, MAX_REASON)

/**
 * Open the deployment row before the build starts, so the work is visible while
 * it is happening and survives as a `failed` row if it never finishes.
 *
 * `hostPort` stays null: a port is worth allocating once there is an image worth
 * publishing, and the column is nullable for exactly this reason.
 */
export async function openDeployment(
  ctx: AppContext,
  input: {
    serviceId: string
    nodeId: string | null
    gitSha: string | null
    /**
     * What the builder was given, when this deploy uploaded a context.
     *
     * Copied onto the row here because it is the last moment it exists: the
     * extracted context and its listing are both removed when the build ends,
     * and a build failure cannot be explained without knowing what went in.
     */
    buildContext?: { entries: string[]; total: number; bytes: number } | null
  }
): Promise<string> {
  const [row] = await ctx.db
    .insert(deployments)
    .values({
      serviceId: input.serviceId,
      nodeId: input.nodeId,
      gitSha: input.gitSha,
      buildContext: input.buildContext ?? null,
      status: 'queued',
    })
    .returning({ id: deployments.id })
  return row!.id
}

export type PhaseWriter = {
  readonly deploymentId: string
  /** Advance the row. A phase earlier than the current one is ignored. */
  set(phase: DeployPhase): Promise<void>
  /**
   * Pass as `BuildRequest.onProgress`. Called from the builder's stdout, so it
   * returns immediately and swallows its own storage failures — a Redis blip
   * must not fail a build that is otherwise going fine.
   */
  onBuildProgress(progress: BuildProgress): void
  /** Record the failure on the row instead of losing it with the exception. */
  fail(reason: string): Promise<void>
  /** Drop the volatile line once the deploy has left the build phases. */
  clear(): Promise<void>
}

export function phaseWriter(ctx: AppContext, deploymentId: string): PhaseWriter {
  let phase: DeployPhase = 'queued'
  let settled = false
  let lastLineAt = 0

  const clear = async (): Promise<void> => {
    await ctx.redis.del(lineKey(deploymentId))
  }

  const set = async (next: DeployPhase): Promise<void> => {
    // The build reports `pushing` from a stdout handler while the caller may
    // already have moved on, and a late write would walk the row backwards.
    if (settled || ORDER.indexOf(next) <= ORDER.indexOf(phase)) return
    phase = next
    await ctx.db.update(deployments).set({ status: next }).where(eq(deployments.id, deploymentId))
  }

  return {
    deploymentId,
    set,
    clear,

    onBuildProgress(progress) {
      if (progress.phase === 'pushing') void set('pushing').catch(() => {})

      const now = Date.now()
      if (now - lastLineAt < LINE_MIN_INTERVAL_MS) return
      lastLineAt = now
      void ctx.redis
        .set(
          lineKey(deploymentId),
          JSON.stringify({ ...progress, at: new Date().toISOString() }),
          'EX',
          LINE_TTL_SEC
        )
        .catch(() => {})
    },

    async fail(reason) {
      settled = true
      await ctx.db
        .update(deployments)
        .set({ status: 'failed', failureReason: cleanReason(reason), finishedAt: new Date() })
        .where(eq(deployments.id, deploymentId))
      await clear().catch(() => {})
    },
  }
}

/** What the CLI polls for while it draws the ladder. */
export type DeployProgress = {
  deploymentId: string
  /** Any `deployment_status`, terminal included — that is how a poller knows to stop. */
  status: string
  since: string
  gitSha: string | null
  nodeName: string | null
  failureReason: string | null
  /** The volatile line, present only while a build is in flight. */
  detail?: string
  step?: number
  ofSteps?: number
  platform?: string
  /**
   * Whether this platform is being built under emulation.
   *
   * The single most useful thing this payload can say. A build that takes
   * three minutes instead of twenty seconds is almost always an arm64 image
   * built on an amd64 control plane through QEMU, and without being told,
   * that reads as a hang. Only the control plane knows its own architecture,
   * so only the control plane can answer this.
   */
  emulated?: boolean
  /**
   * How long this service's deploys usually take, in milliseconds.
   *
   * The median of its own recent successes — not an average, which one
   * pathological build skews, and not a guess. Absent when there is no
   * history, in which case the caller must say so rather than invent a bar.
   */
  typicalMs?: number
}

/**
 * The newest deployment for a service, with its live build line merged in.
 *
 * Deliberately not filtered to in-flight rows: a poller that gets null once the
 * deploy finishes cannot tell success from a service that never deployed, so the
 * terminal status is part of the answer. One indexed row plus one Redis GET,
 * which is what makes this cheap enough to poll every second.
 */
export async function readProgress(
  ctx: AppContext,
  serviceId: string
): Promise<DeployProgress | null> {
  const [row] = await ctx.db
    .select({
      id: deployments.id,
      status: deployments.status,
      startedAt: deployments.startedAt,
      gitSha: deployments.gitSha,
      failureReason: deployments.failureReason,
      nodeName: nodes.name,
    })
    .from(deployments)
    .leftJoin(nodes, eq(nodes.id, deployments.nodeId))
    .where(eq(deployments.serviceId, serviceId))
    .orderBy(desc(deployments.startedAt))
    .limit(1)

  if (!row) return null

  // What this service's deploys usually cost, from its own history.
  //
  // Median of the last five that actually reached `running`, so a single
  // twenty-minute emulated build does not move the estimate for everything
  // after it. Failures are excluded: they finish early and would make the
  // typical look faster than any real deploy.
  const past = await ctx.db
    .select({ startedAt: deployments.startedAt, finishedAt: deployments.finishedAt })
    .from(deployments)
    .where(
      and(
        eq(deployments.serviceId, serviceId),
        ne(deployments.id, row.id),
        inArray(deployments.status, ['running', 'superseded']),
        isNotNull(deployments.finishedAt)
      )
    )
    .orderBy(desc(deployments.startedAt))
    .limit(5)

  const durations = past
    .map((d) => d.finishedAt!.getTime() - d.startedAt.getTime())
    .filter((ms) => ms > 0)
    .sort((a, b) => a - b)
  const typicalMs = durations.length ? durations[Math.floor(durations.length / 2)] : undefined

  const progress: DeployProgress = {
    ...(typicalMs ? { typicalMs } : {}),
    deploymentId: row.id,
    status: row.status,
    since: row.startedAt.toISOString(),
    gitSha: row.gitSha,
    nodeName: row.nodeName ?? null,
    failureReason: row.failureReason,
  }

  if (!BUILD_PHASES.has(row.status)) return progress

  // A stale line must not decorate a row that has moved on, so it is only read
  // for the phases that produce one.
  const raw = await ctx.redis.get(lineKey(row.id)).catch(() => null)
  if (!raw) return progress
  try {
    const line = JSON.parse(raw) as BuildProgress
    if (typeof line.detail === 'string') progress.detail = line.detail
    if (typeof line.step === 'number') progress.step = line.step
    if (typeof line.ofSteps === 'number') progress.ofSteps = line.ofSteps
    if (typeof line.platform === 'string') {
      progress.platform = line.platform
      // "linux/arm64" against a control plane running amd64. Compared on the
      // architecture alone: the OS is linux on both sides of any build we do.
      const target = line.platform.split('/')[1]
      const host = process.arch === 'x64' ? 'amd64' : process.arch === 'arm64' ? 'arm64' : process.arch
      if (target && target !== host) progress.emulated = true
    }
  } catch {
    // A malformed value is not worth failing the request over.
  }
  return progress
}

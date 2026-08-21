import { and, eq, inArray } from 'drizzle-orm'
import { deployments, services } from '../db/schema.js'
import type { AppContext } from '../api/context.js'
import type { FleetEventPayload } from '../lib/events.js'

export type Drift = {
  service: string
  expected: 'running'
  actual: string
  deploymentId: string
}

/**
 * Drift detection (PRD 7.5).
 *
 * The agent reconciles toward desired state on its own; drift is what the
 * control plane notices *despite* that — a container the node says is not
 * running when the control plane believes it is. Usually a crash loop, an
 * image that will not start, or a container someone stopped by hand.
 *
 * It reports rather than silently re-converging: a service that keeps dying is
 * information the operator needs, not something to paper over by restarting it
 * forever.
 */
export async function detectDrift(
  ctx: AppContext,
  nodeId: string,
  fleetId: string,
  reported: Array<{ name: string; state: string }>,
  opts: { onEvent?: (e: FleetEventPayload) => void | Promise<void> } = {}
): Promise<Drift[]> {
  const expected = await ctx.db
    .select({ id: deployments.id, service: services.name })
    .from(deployments)
    .innerJoin(services, eq(services.id, deployments.serviceId))
    .where(and(eq(deployments.nodeId, nodeId), eq(deployments.status, 'running')))

  if (!expected.length) return []

  const actual = new Map(reported.map((c) => [c.name, c.state]))
  const drifted: Drift[] = []

  for (const row of expected) {
    const state = actual.get(row.service)
    // Absent is not necessarily drift: the agent may not have polled yet, or
    // Docker may be unreachable — in which case it reports nothing at all.
    if (state === undefined) {
      if (reported.length === 0) continue
      drifted.push({ service: row.service, expected: 'running', actual: 'missing', deploymentId: row.id })
      continue
    }
    if (state !== 'running') {
      drifted.push({ service: row.service, expected: 'running', actual: state, deploymentId: row.id })
    }
  }

  for (const d of drifted) {
    // "restarting" repeatedly is the signature of a crash loop, and deserves
    // its own event rather than being filed as generic drift.
    const type = d.actual === 'restarting' ? 'service.crash_looping' : 'drift.detected'
    await opts.onEvent?.({
      type,
      fleetId,
      at: new Date().toISOString(),
      subject: d.service,
      detail: { nodeId, expected: d.expected, actual: d.actual },
    })
  }

  return drifted
}

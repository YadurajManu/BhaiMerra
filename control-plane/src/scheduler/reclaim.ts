import { and, eq, inArray } from 'drizzle-orm'
import { deployments, services, nodes, fleets, placementEvents } from '../db/schema.js'
import { recordAudit } from '../lib/audit.js'
import type { AppContext } from '../api/context.js'
import type { FleetEventPayload } from '../lib/events.js'

export type ReclaimOutcome = {
  service: string
  action: 'reclaimed' | 'left' | 'resumed'
  detail: string
}

/**
 * FR-9 — what happens when a node that was down comes back.
 *
 * Three policies, per service or inherited from the fleet:
 *   eager  move it back now. Costs a second restart.
 *   idle   leave it where it landed; it returns at the next deploy. Default,
 *          because a surprise restart is worse than suboptimal placement.
 *   manual do nothing until a human says so.
 *
 * A pinned service is a separate case: it never left, so it is resumed on the
 * node rather than "reclaimed" from anywhere.
 */
export async function reclaimToNode(
  ctx: AppContext,
  fleetId: string,
  returnedNodeId: string,
  opts: { onEvent?: (e: FleetEventPayload) => void | Promise<void> } = {}
): Promise<ReclaimOutcome[]> {
  const [fleet] = await ctx.db.select().from(fleets).where(eq(fleets.id, fleetId)).limit(1)
  if (!fleet) return []

  const [node] = await ctx.db.select().from(nodes).where(eq(nodes.id, returnedNodeId)).limit(1)
  if (!node) return []

  const outcomes: ReclaimOutcome[] = []

  // A pinned service held on this node has been waiting for exactly this.
  const held = await ctx.db
    .select({ deployment: deployments, service: services })
    .from(deployments)
    .innerJoin(services, eq(services.id, deployments.serviceId))
    .where(
      and(eq(deployments.nodeId, returnedNodeId), eq(deployments.status, 'pinned_unavailable'))
    )

  for (const { deployment, service } of held) {
    await ctx.db
      .update(deployments)
      .set({ status: 'deploying', failureReason: null })
      .where(eq(deployments.id, deployment.id))

    outcomes.push({
      service: service.name,
      action: 'resumed',
      detail: `its node is back; the agent will start it again`,
    })
    await opts.onEvent?.({
      type: 'service.rescheduled',
      fleetId,
      at: new Date().toISOString(),
      subject: service.name,
      detail: { to: node.name, reason: 'reclaim', pinned: true },
    })
  }

  // Services that moved away and are pinned/preferred back to this node.
  const candidates = await ctx.db
    .select({ deployment: deployments, service: services })
    .from(deployments)
    .innerJoin(services, eq(services.id, deployments.serviceId))
    .where(
      and(
        eq(services.fleetId, fleetId),
        eq(services.pinnedNodeId, returnedNodeId),
        inArray(deployments.status, ['deploying', 'running'])
      )
    )

  for (const { deployment, service } of candidates) {
    if (deployment.nodeId === returnedNodeId) continue // already home

    const policy = service.reclaimPolicy ?? fleet.defaultReclaimPolicy
    if (policy !== 'eager') {
      outcomes.push({
        service: service.name,
        action: 'left',
        detail:
          policy === 'idle'
            ? 'staying put until the next deploy (reclaim: idle)'
            : 'awaiting manual confirmation (reclaim: manual)',
      })
      continue
    }

    await ctx.db.transaction(async (tx) => {
      await tx
        .update(deployments)
        .set({ status: 'superseded', finishedAt: new Date() })
        .where(eq(deployments.id, deployment.id))
      await tx.insert(deployments).values({
        serviceId: service.id,
        gitSha: deployment.gitSha,
        imageTags: deployment.imageTags,
        nodeId: returnedNodeId,
        status: 'deploying',
      })
      await tx.insert(placementEvents).values({
        serviceId: service.id,
        fromNodeId: deployment.nodeId,
        toNodeId: returnedNodeId,
        reason: 'reclaim',
        detail: { policy },
      })
      await recordAudit(tx, {
        orgId: fleet.orgId,
        actorKind: 'system',
        action: 'service.reclaimed',
        targetType: 'service',
        targetId: service.id,
        metadata: { to: returnedNodeId, policy },
      })
    })

    outcomes.push({
      service: service.name,
      action: 'reclaimed',
      detail: `moved back to ${node.name} (reclaim: eager)`,
    })
    await opts.onEvent?.({
      type: 'service.rescheduled',
      fleetId,
      at: new Date().toISOString(),
      subject: service.name,
      detail: { from: deployment.nodeId, to: node.name, reason: 'reclaim' },
    })
  }

  return outcomes
}

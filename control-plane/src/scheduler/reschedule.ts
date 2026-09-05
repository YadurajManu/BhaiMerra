import { and, eq, inArray } from 'drizzle-orm'
import { deployments, services, placementEvents, fleets } from '../db/schema.js'
import { recordAudit } from '../lib/audit.js'
import { place, rejectionCounts } from './placement.js'
import { allocateHostPort, invalidateRoutesForService } from '../ingress/routes.js'
import { fleetSnapshot, toServiceSpec } from './snapshot.js'
import type { AppContext } from '../api/context.js'
import type { FleetEventPayload } from '../lib/events.js'

export type RescheduleOutcome =
  | { service: string; action: 'moved'; fromNodeId: string; toNodeId: string; toNodeName: string }
  | { service: string; action: 'pinned_held'; nodeId: string; reason: string }
  | { service: string; action: 'stranded'; reason: string }

/**
 * FR-6 and FR-7 — the actual failover.
 *
 * Called when a node is marked down. Flexible and preferred services are
 * re-placed onto the best remaining node. Pinned services are deliberately
 * left where they are and raise their own distinct alert: moving a database
 * away from its volume is worse than the outage it was meant to fix.
 */
export async function rescheduleFromNode(
  ctx: AppContext,
  fleetId: string,
  downNodeId: string,
  opts: { onEvent?: (e: FleetEventPayload) => void | Promise<void> } = {}
): Promise<RescheduleOutcome[]> {
  const [fleet] = await ctx.db.select().from(fleets).where(eq(fleets.id, fleetId)).limit(1)
  if (!fleet) return []

  // Everything that was actively running on the node that just went dark.
  const affected = await ctx.db
    .select({ deployment: deployments, service: services })
    .from(deployments)
    .innerJoin(services, eq(services.id, deployments.serviceId))
    .where(
      and(
        eq(deployments.nodeId, downNodeId),
        inArray(deployments.status, ['deploying', 'running'])
      )
    )

  if (!affected.length) return []

  const outcomes: RescheduleOutcome[] = []
  const emit = async (e: FleetEventPayload) => opts.onEvent?.(e)

  for (const { deployment, service } of affected) {
    // FR-7: never silently relocate something the user pinned.
    if (service.placementPolicy === 'pinned') {
      await ctx.db.transaction(async (tx) => {
        await tx
          .update(deployments)
          .set({ status: 'pinned_unavailable', failureReason: 'node_down_pinned' })
          .where(eq(deployments.id, deployment.id))
        await recordAudit(tx, {
          orgId: fleet.orgId,
          actorKind: 'system',
          action: 'service.pinned_unavailable',
          targetType: 'service',
          targetId: service.id,
          metadata: { nodeId: downNodeId, policy: 'pinned' },
        })
      })

      outcomes.push({
        service: service.name,
        action: 'pinned_held',
        nodeId: downNodeId,
        reason: 'pinned to the node that went down; not moved by design',
      })
      await emit({
        type: 'service.pinned_unavailable',
        fleetId,
        at: new Date().toISOString(),
        subject: service.name,
        detail: {
          nodeId: downNodeId,
          why: 'Pinned services are never relocated automatically. Its data lives on that node.',
        },
      })
      continue
    }

    // Recompute the snapshot per service: each successful move consumes
    // capacity, and the next decision has to see that.
    const { nodes: snapshot, placements, antiAffinityBy } = await fleetSnapshot(ctx, fleetId)
    const spec = toServiceSpec(service, service.persistentVolume ? downNodeId : null)
    const decision = place(spec, snapshot, placements, antiAffinityBy)

    if (decision.outcome !== 'placed') {
      // Code first, detail after. The code is what `placeStranded` matches on
      // and what the dashboard's glossary looks up, so it stays the leading
      // token; the detail is the part a person actually needs, and storing
      // only the code sent every reader back to the event stream to find out
      // whether the node was full, offline, or the wrong architecture.
      const why = rejectionCounts(decision.rejected)
      await ctx.db
        .update(deployments)
        .set({
          status: 'failed',
          failureReason: why ? `no_eligible_node: ${why}` : 'no_eligible_node',
        })
        .where(eq(deployments.id, deployment.id))

      outcomes.push({ service: service.name, action: 'stranded', reason: decision.summary })
      await emit({
        type: 'service.rescheduled',
        fleetId,
        at: new Date().toISOString(),
        subject: service.name,
        detail: { failed: true, summary: decision.summary, rejected: decision.rejected },
      })
      continue
    }

    // A new node means a new host port, and the route must point at it.
    const hostPort = await allocateHostPort(ctx, decision.nodeId)

    await ctx.db.transaction(async (tx) => {
      // The old deployment is superseded, not deleted: the timeline should
      // still show where the service used to be.
      await tx
        .update(deployments)
        .set({ status: 'superseded', finishedAt: new Date() })
        .where(eq(deployments.id, deployment.id))

      await tx.insert(deployments).values({
        serviceId: service.id,
        gitSha: deployment.gitSha,
        imageTags: deployment.imageTags,
        nodeId: decision.nodeId,
        status: 'deploying',
        hostPort,
      })

      await tx.insert(placementEvents).values({
        serviceId: service.id,
        fromNodeId: downNodeId,
        toNodeId: decision.nodeId,
        reason: 'failover',
        // Record why this node won, so the timeline can answer "why there?"
        detail: {
          score: decision.candidates[0]?.score,
          breakdown: decision.candidates[0]?.breakdown,
          consideredNodes: decision.candidates.length,
          rejected: decision.rejected.map((r) => ({ node: r.nodeName, code: r.code })),
        },
      })

      await recordAudit(tx, {
        orgId: fleet.orgId,
        actorKind: 'system',
        action: 'service.rescheduled',
        targetType: 'service',
        targetId: service.id,
        metadata: { from: downNodeId, to: decision.nodeId, reason: 'failover' },
      })
    })

    // FR-8: the public route follows the service within one reschedule cycle.
    await invalidateRoutesForService(ctx, service.id)

    outcomes.push({
      service: service.name,
      action: 'moved',
      fromNodeId: downNodeId,
      toNodeId: decision.nodeId,
      toNodeName: decision.nodeName,
    })
    await emit({
      type: 'service.rescheduled',
      fleetId,
      at: new Date().toISOString(),
      subject: service.name,
      detail: {
        from: downNodeId,
        to: decision.nodeName,
        score: decision.candidates[0]?.score,
        reason: 'failover',
      },
    })
  }

  return outcomes
}

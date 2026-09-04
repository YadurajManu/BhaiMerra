import { and, desc, eq, inArray, notInArray } from 'drizzle-orm'
import { deployments, services, nodes, fleets, placementEvents } from '../db/schema.js'
import { recordAudit } from '../lib/audit.js'
import { place } from './placement.js'
import { fleetSnapshot, toServiceSpec } from './snapshot.js'
import { allocateHostPort } from '../ingress/routes.js'
import type { AppContext } from '../api/context.js'
import type { FleetEventPayload } from '../lib/events.js'

export type ReclaimOutcome = {
  service: string
  action: 'reclaimed' | 'left' | 'resumed' | 'unstranded'
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
    // startedAt too, or this resume is dead on arrival. The row has been held
    // as pinned_unavailable for as long as its node was away, and the rollout
    // window is measured from startedAt -- so without this it re-enters
    // `deploying` already expired and the next sweep fails it before the agent
    // has had a chance to start anything. That is what took a database and an
    // API down after a control-plane restart: held, resumed, failed within a
    // minute, then reaped by the agent for being absent from desired state.
    await ctx.db
      .update(deployments)
      .set({ status: 'deploying', failureReason: null, startedAt: new Date() })
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

  outcomes.push(...(await placeStranded(ctx, fleetId, opts)))

  return outcomes
}

/**
 * Services that had nowhere to go, given somewhere to go.
 *
 * When a node goes down, a flexible service on it is re-placed — unless
 * nothing in the fleet can take it, in which case rescheduleFromNode writes
 * `failed` / `no_eligible_node` and moves on. That is accurate at the time and
 * wrong a moment later: a strand is a statement about capacity right now, not
 * a property of the service. Nothing revisited it, so on a single-node fleet
 * every flexible service stayed dead after its node came back, while pinned
 * ones were resumed. Recovering meant redeploying by hand, and nothing in the
 * fleet said that was needed.
 *
 * Retried here because a node returning is the event most likely to have
 * created the capacity. It is not the only one — a new node, or a service
 * being removed, frees capacity too — so this is where a strand is most often
 * cleared, not the only place it ever could be.
 *
 * Services that are already live are skipped, and a strand that still cannot
 * be placed is left exactly as it is: retried again next time, with no churn
 * and no second failure row.
 */
async function placeStranded(
  ctx: AppContext,
  fleetId: string,
  opts: { onEvent?: (event: FleetEventPayload) => void | Promise<void> } = {}
): Promise<ReclaimOutcome[]> {
  const [fleet] = await ctx.db.select().from(fleets).where(eq(fleets.id, fleetId)).limit(1)
  if (!fleet) return []

  const stranded = await ctx.db
    .select({ deployment: deployments, service: services })
    .from(deployments)
    .innerJoin(services, eq(services.id, deployments.serviceId))
    .where(
      and(
        eq(services.fleetId, fleetId),
        eq(deployments.status, 'failed'),
        eq(deployments.failureReason, 'no_eligible_node')
      )
    )
    .orderBy(desc(deployments.startedAt))

  if (!stranded.length) return []

  // A service with something live is not stranded, whatever an old row says.
  const live = await ctx.db
    .select({ serviceId: deployments.serviceId })
    .from(deployments)
    .innerJoin(services, eq(services.id, deployments.serviceId))
    .where(
      and(
        eq(services.fleetId, fleetId),
        inArray(deployments.status, ['deploying', 'running', 'pinned_unavailable'])
      )
    )
  const isLive = new Set(live.map((d) => d.serviceId))

  const outcomes: ReclaimOutcome[] = []
  const handled = new Set<string>()

  for (const { deployment, service } of stranded) {
    // Newest first, so only the most recent strand per service is retried.
    if (isLive.has(service.id) || handled.has(service.id)) continue
    handled.add(service.id)

    // Recomputed per service: each placement consumes capacity the next
    // decision has to see.
    const { nodes: snapshot, placements, antiAffinityBy } = await fleetSnapshot(ctx, fleetId)
    const decision = place(toServiceSpec(service, null), snapshot, placements, antiAffinityBy)
    if (decision.outcome !== 'placed') continue

    const hostPort = await allocateHostPort(ctx, decision.nodeId)

    await ctx.db.transaction(async (tx) => {
      // The failed row stays failed: it is the record of the strand, and
      // rewriting history to make a recovery look seamless helps nobody.
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
        fromNodeId: deployment.nodeId,
        toNodeId: decision.nodeId,
        // 'failover' rather than a new enum member: this is the failover that
        // could not complete when the node went down, finishing late. The
        // detail says what actually happened, without a migration for a word.
        reason: 'failover',
        detail: {
          was: 'no_eligible_node',
          completing: 'a failover that had nowhere to go when it was attempted',
          consideredNodes: decision.candidates.length,
        },
      })
      await recordAudit(tx, {
        orgId: fleet.orgId,
        actorKind: 'system',
        action: 'service.rescheduled',
        targetType: 'service',
        targetId: service.id,
        metadata: { to: decision.nodeId, reason: 'unstranded' },
      })
    })

    outcomes.push({
      service: service.name,
      action: 'unstranded',
      detail: 'there is somewhere to run it again',
    })
    await opts.onEvent?.({
      type: 'service.rescheduled',
      fleetId,
      at: new Date().toISOString(),
      subject: service.name,
      detail: { to: decision.nodeId, reason: 'unstranded' },
    })
  }

  return outcomes
}

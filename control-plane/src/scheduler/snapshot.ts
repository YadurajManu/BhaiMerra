import { and, eq, inArray } from 'drizzle-orm'
import { nodes, services, deployments } from '../db/schema.js'
import type { AppContext } from '../api/context.js'
import type { Arch, NodeSnapshot, Placements, ServiceSpec } from './types.js'

/** Deployment states that still occupy capacity on a node. */
const ACTIVE = ['deploying', 'running'] as const

/**
 * Build the view of a fleet the scheduler reasons over.
 *
 * Committed RAM is summed from active deployments rather than read from the
 * heartbeat: what the scheduler must not overcommit is what it has *promised*,
 * not what a container happens to be using this second. A service that is idle
 * right now still owns its reservation.
 */
export async function fleetSnapshot(
  ctx: AppContext,
  fleetId: string
): Promise<{ nodes: NodeSnapshot[]; placements: Placements }> {
  const nodeRows = await ctx.db.select().from(nodes).where(eq(nodes.fleetId, fleetId))

  const active = await ctx.db
    .select({
      nodeId: deployments.nodeId,
      serviceName: services.name,
      requestRamMb: services.requestRamMb,
    })
    .from(deployments)
    .innerJoin(services, eq(services.id, deployments.serviceId))
    .where(and(eq(services.fleetId, fleetId), inArray(deployments.status, [...ACTIVE])))

  const committed = new Map<string, number>()
  const placements: Placements = {}
  for (const row of active) {
    if (!row.nodeId) continue
    committed.set(row.nodeId, (committed.get(row.nodeId) ?? 0) + row.requestRamMb)
    placements[row.serviceName] = row.nodeId
  }

  const snapshots = await Promise.all(
    nodeRows.map(async (n): Promise<NodeSnapshot> => {
      const hb = await ctx.heartbeats.last(n.id)
      return {
        id: n.id,
        name: n.name,
        arch: n.arch,
        status: n.status,
        ramMb: n.ramMb,
        cpuCores: n.cpuCores,
        hasGpu: n.hasGpu,
        reliabilityTier: n.reliabilityTier,
        tags: n.tags,
        committedRamMb: committed.get(n.id) ?? 0,
        // Absent rather than 0 when unknown: the ranker treats unknown as
        // mid-range, and claiming a node is idle would make it win every time.
        loadFactor: hb ? Math.min(1, Math.max(0, hb.cpuPct / 100)) : undefined,
      }
    })
  )

  return { nodes: snapshots, placements }
}

/** Translate a stored service row into the scheduler's input shape. */
export function toServiceSpec(
  row: typeof services.$inferSelect,
  volumeNodeId?: string | null
): ServiceSpec {
  return {
    id: row.id,
    name: row.name,
    placementPolicy: row.placementPolicy,
    pinnedNodeId: row.pinnedNodeId,
    requestRamMb: row.requestRamMb,
    requestCpu: Number(row.requestCpu) || 0.25,
    requiresGpu: row.requiresGpu,
    minReliabilityTier: row.minReliabilityTier,
    compatibleArches: row.compatibleArches as Arch[],
    affinity: row.affinity,
    antiAffinity: row.antiAffinity,
    persistentVolume: row.persistentVolume,
    volumeNodeId: volumeNodeId ?? null,
  }
}

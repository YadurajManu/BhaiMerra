import type {
  AntiAffinityIndex,
  Candidate,
  Decision,
  NodeSnapshot,
  Placements,
  Rejection,
  ReliabilityTier,
  ServiceSpec,
} from './types.js'

/** Reliability is a ladder, so "at least standard" is a comparison. */
const TIER_RANK: Record<ReliabilityTier, number> = {
  opportunistic: 0,
  standard: 1,
  high: 2,
}

/**
 * Ranking weights (tech doc §8). Headroom dominates on purpose: a homelab
 * node driven into swap takes its neighbours down with it, which is a worse
 * outcome than leaving a node underused.
 */
export const WEIGHTS = { headroom: 0.5, reliability: 0.3, load: 0.2 } as const

const freeRam = (node: NodeSnapshot) => Math.max(0, node.ramMb - node.committedRamMb)

/**
 * Hard constraints. Every one of these is a yes or no — nothing here is a
 * preference, and a node failing any single check is ineligible.
 *
 * Rejections are collected rather than short-circuited: when a deploy fails,
 * "no eligible node" is useless and "node-03 failed reliability, node-05
 * failed RAM" is actionable.
 */
export function filterNodes(
  service: ServiceSpec,
  nodes: NodeSnapshot[],
  placements: Placements = {},
  antiAffinityBy: AntiAffinityIndex = {}
): { eligible: NodeSnapshot[]; rejected: Rejection[] } {
  const eligible: NodeSnapshot[] = []
  const rejected: Rejection[] = []

  const reject = (node: NodeSnapshot, code: Rejection['code'], detail: string) =>
    rejected.push({ nodeId: node.id, nodeName: node.name, code, detail })

  for (const node of nodes) {
    if (node.status === 'offline') {
      reject(node, 'offline', 'node is not reporting heartbeats')
      continue
    }
    if (node.status === 'cordoned') {
      reject(node, 'cordoned', 'node is cordoned and excluded from scheduling')
      continue
    }
    if (node.status === 'draining') {
      reject(node, 'draining', 'node is draining for maintenance')
      continue
    }

    // A pinned service is not really scheduled; it is asserted. Everything
    // else is still evaluated so the rejection list stays informative.
    if (service.placementPolicy === 'pinned' && service.pinnedNodeId !== node.id) {
      reject(node, 'not_pinned_node', `service is pinned to another node`)
      continue
    }

    // A volume cannot follow the workload across machines (PRD 7.7).
    if (service.persistentVolume && service.volumeNodeId && service.volumeNodeId !== node.id) {
      reject(node, 'volume_elsewhere', `volume lives on another node and cannot move automatically`)
      continue
    }

    if (service.compatibleArches.length && !service.compatibleArches.includes(node.arch as never)) {
      reject(
        node,
        'arch_incompatible',
        `node is ${node.arch}; image was built for ${service.compatibleArches.join(', ')}`
      )
      continue
    }

    const available = freeRam(node)
    if (available < service.requestRamMb) {
      reject(
        node,
        'insufficient_ram',
        `needs ${service.requestRamMb}MB, ${available}MB free of ${node.ramMb}MB`
      )
      continue
    }

    if (service.requiresGpu && !node.hasGpu) {
      reject(node, 'no_gpu', 'service requires a GPU and none was detected')
      continue
    }

    if (TIER_RANK[node.reliabilityTier] < TIER_RANK[service.minReliabilityTier]) {
      reject(
        node,
        'reliability_too_low',
        `node is ${node.reliabilityTier}, service requires at least ${service.minReliabilityTier}`
      )
      continue
    }

    const missingTag = service.requiredTags?.find((t) => !node.tags.includes(t))
    if (missingTag) {
      reject(node, 'missing_tag', `node is missing required tag "${missingTag}"`)
      continue
    }

    // Forward: this service says keep away from something already here.
    const conflict = service.antiAffinity.find((other) => placements[other] === node.id)
    if (conflict) {
      reject(node, 'anti_affinity', `"${conflict}" already runs here and must be kept apart`)
      continue
    }

    // Reverse: something already here said keep away from *this* service.
    // Without this the rule depends on which service deploys first.
    const objector = Object.keys(placements).find(
      (other) =>
        placements[other] === node.id && (antiAffinityBy[other] ?? []).includes(service.name)
    )
    if (objector) {
      reject(node, 'anti_affinity', `"${objector}" runs here and declares anti-affinity with this service`)
      continue
    }

    // Affinity is a hard constraint only when the target is actually placed
    // somewhere. Requiring co-location with a service that is down would make
    // one outage cascade into two.
    const unmetAffinity = service.affinity.find(
      (other) => placements[other] !== undefined && placements[other] !== node.id
    )
    if (unmetAffinity) {
      reject(node, 'affinity_absent', `must run alongside "${unmetAffinity}", which is on another node`)
      continue
    }

    eligible.push(node)
  }

  return { eligible, rejected }
}

/** Rank eligible nodes. Higher is better; every component is normalised 0..1. */
export function rankNodes(service: ServiceSpec, eligible: NodeSnapshot[]): Candidate[] {
  return eligible
    .map((node) => {
      const available = freeRam(node)
      // Headroom *after* placing this service, so a node that would be left
      // full scores worse than one that would still have room.
      const headroom = node.ramMb > 0 ? Math.max(0, available - service.requestRamMb) / node.ramMb : 0
      const reliability = TIER_RANK[node.reliabilityTier] / TIER_RANK.high
      const load = 1 - Math.min(1, Math.max(0, node.loadFactor ?? 0.5))

      const score =
        WEIGHTS.headroom * headroom + WEIGHTS.reliability * reliability + WEIGHTS.load * load

      return {
        nodeId: node.id,
        nodeName: node.name,
        score: Number(score.toFixed(6)),
        breakdown: {
          headroom: Number(headroom.toFixed(4)),
          reliability: Number(reliability.toFixed(4)),
          load: Number(load.toFixed(4)),
        },
        freeRamMb: available,
      }
    })
    .sort((a, b) =>
      // Ties break on node id, not insertion order: two runs over the same
      // fleet must choose the same node, or services flap between deploys.
      b.score !== a.score ? b.score - a.score : a.nodeId.localeCompare(b.nodeId)
    )
}

/**
 * The placement decision (tech doc §8): filter on hard constraints, rank the
 * survivors, take the top one. Pure over a snapshot — no I/O — so it can be
 * replayed against a recorded fleet state to explain a past decision.
 */
export function place(
  service: ServiceSpec,
  nodes: NodeSnapshot[],
  placements: Placements = {},
  antiAffinityBy: AntiAffinityIndex = {}
): Decision {
  const warnings: string[] = []

  // FR-18: a stateful service that may be moved is almost always a mistake.
  if (service.persistentVolume && service.placementPolicy === 'flexible') {
    warnings.push(
      `"${service.name}" declares a persistent volume but is set to flexible placement. ` +
        `Data does not move between machines; pin it to the node holding the volume.`
    )
  }

  if (service.placementPolicy === 'pinned' && !service.pinnedNodeId) {
    return {
      outcome: 'no_eligible_node',
      candidates: [],
      rejected: [],
      warnings,
      summary: `"${service.name}" is pinned but names no node.`,
    }
  }

  const { eligible, rejected } = filterNodes(service, nodes, placements, antiAffinityBy)

  if (!eligible.length) {
    return {
      outcome: 'no_eligible_node',
      candidates: [],
      rejected,
      warnings,
      summary: summarise(service, nodes, rejected),
    }
  }

  const candidates = rankNodes(service, eligible)
  const winner = candidates[0]!

  return {
    outcome: 'placed',
    nodeId: winner.nodeId,
    nodeName: winner.nodeName,
    candidates,
    rejected,
    warnings,
  }
}

/** One line the CLI can print verbatim on exit code 3. */
/**
 * Why the nodes were refused, counted.
 *
 * The part that differs between two `no_eligible_node` failures, and the only
 * part worth storing on a deployment row: "1 insufficient ram" and "1 offline"
 * are the same outcome and completely different problems, and the code alone
 * cannot tell an operator which one they have.
 */
export function rejectionCounts(rejected: Rejection[]): string {
  const counts = new Map<string, number>()
  for (const r of rejected) counts.set(r.code, (counts.get(r.code) ?? 0) + 1)

  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([code, n]) => `${n} ${code.replace(/_/g, ' ')}`)
    .join(', ')
}

function summarise(service: ServiceSpec, nodes: NodeSnapshot[], rejected: Rejection[]): string {
  if (!nodes.length) return `No nodes in this fleet to place "${service.name}" on.`
  return `No eligible node for "${service.name}" among ${nodes.length}: ${rejectionCounts(rejected)}.`
}

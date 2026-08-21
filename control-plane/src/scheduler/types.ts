import type { Role } from '../auth/rbac.js'

export type Arch = 'arm64' | 'armv7' | 'amd64'
export type ReliabilityTier = 'opportunistic' | 'standard' | 'high'
export type PlacementPolicy = 'pinned' | 'preferred' | 'flexible'

/** A node as the scheduler sees it: capability plus what is already on it. */
export type NodeSnapshot = {
  id: string
  name: string
  arch: string
  status: 'online' | 'offline' | 'cordoned' | 'draining'
  ramMb: number
  cpuCores: number
  hasGpu: boolean
  reliabilityTier: ReliabilityTier
  tags: string[]
  /** RAM already committed to services placed here. */
  committedRamMb: number
  /** 0..1, from the most recent heartbeat. Absent means unknown. */
  loadFactor?: number
}

export type ServiceSpec = {
  id: string
  name: string
  placementPolicy: PlacementPolicy
  pinnedNodeId?: string | null
  requestRamMb: number
  requestCpu: number
  requiresGpu: boolean
  minReliabilityTier: ReliabilityTier
  /** Empty means "any architecture the image was built for". */
  compatibleArches: Arch[]
  affinity: string[]
  antiAffinity: string[]
  requiredTags?: string[]
  persistentVolume: boolean
  volumeNodeId?: string | null
}

/** Which services currently sit on which node, by service name. */
export type Placements = Record<string, string | undefined>

/**
 * anti_affinity declared by *other* services, by service name.
 *
 * Needed because anti-affinity is symmetric in meaning but asymmetric in the
 * file: if web says "keep away from img-proxy", placing img-proxy has to
 * honour it too, or the rule works only when web happens to deploy first.
 */
export type AntiAffinityIndex = Record<string, string[] | undefined>

export type RejectionCode =
  | 'offline'
  | 'cordoned'
  | 'draining'
  | 'arch_incompatible'
  | 'insufficient_ram'
  | 'no_gpu'
  | 'reliability_too_low'
  | 'missing_tag'
  | 'anti_affinity'
  | 'affinity_absent'
  | 'not_pinned_node'
  | 'volume_elsewhere'

export type Rejection = {
  nodeId: string
  nodeName: string
  code: RejectionCode
  /** Written for a human reading the deploy output, not for a parser. */
  detail: string
}

export type Candidate = {
  nodeId: string
  nodeName: string
  score: number
  breakdown: { headroom: number; reliability: number; load: number }
  freeRamMb: number
}

export type Decision =
  | {
      outcome: 'placed'
      nodeId: string
      nodeName: string
      candidates: Candidate[]
      rejected: Rejection[]
      warnings: string[]
    }
  | {
      outcome: 'no_eligible_node'
      candidates: []
      rejected: Rejection[]
      warnings: string[]
      /** Why the deploy failed, phrased for the CLI's exit-code-3 message. */
      summary: string
    }

export type { Role }

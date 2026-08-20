import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { place, filterNodes, rankNodes, WEIGHTS } from '../src/scheduler/placement.js'
import type { NodeSnapshot, ServiceSpec } from '../src/scheduler/types.js'

const node = (over: Partial<NodeSnapshot> & { id: string; name: string }): NodeSnapshot => ({
  arch: 'amd64',
  status: 'online',
  ramMb: 8192,
  cpuCores: 4,
  hasGpu: false,
  reliabilityTier: 'standard',
  tags: [],
  committedRamMb: 0,
  loadFactor: 0.2,
  ...over,
})

const svc = (over: Partial<ServiceSpec> = {}): ServiceSpec => ({
  id: 'svc-1',
  name: 'web',
  placementPolicy: 'flexible',
  requestRamMb: 512,
  requestCpu: 0.5,
  requiresGpu: false,
  minReliabilityTier: 'opportunistic',
  compatibleArches: [],
  affinity: [],
  antiAffinity: [],
  persistentVolume: false,
  ...over,
})

/** A realistic mixed homelab: the PRD's primary persona. */
const homelab = (): NodeSnapshot[] => [
  node({ id: 'n1', name: 'home-server', arch: 'amd64', ramMb: 16384, reliabilityTier: 'high', loadFactor: 0.3 }),
  node({ id: 'n2', name: 'pi-5', arch: 'arm64', ramMb: 8192, reliabilityTier: 'high', loadFactor: 0.5 }),
  node({ id: 'n3', name: 'thinkpad', arch: 'amd64', ramMb: 8192, reliabilityTier: 'opportunistic', loadFactor: 0.4 }),
  node({ id: 'n4', name: 'vps-fra', arch: 'amd64', ramMb: 2048, reliabilityTier: 'high', loadFactor: 0.2 }),
  node({ id: 'n5', name: 'pi-zero', arch: 'armv7', ramMb: 512, reliabilityTier: 'opportunistic', loadFactor: 0.1 }),
]

describe('hard constraint filtering (§8 step 1)', () => {
  test('an offline node is never eligible', () => {
    const nodes = [node({ id: 'n1', name: 'a', status: 'offline' })]
    const { eligible, rejected } = filterNodes(svc(), nodes)
    assert.equal(eligible.length, 0)
    assert.equal(rejected[0]!.code, 'offline')
  })

  test('a cordoned node is excluded but keeps running what it has', () => {
    const { eligible, rejected } = filterNodes(svc(), [node({ id: 'n1', name: 'a', status: 'cordoned' })])
    assert.equal(eligible.length, 0)
    assert.equal(rejected[0]!.code, 'cordoned')
  })

  test('architecture mismatch is rejected with both sides named', () => {
    const { eligible, rejected } = filterNodes(
      svc({ compatibleArches: ['arm64'] }),
      [node({ id: 'n1', name: 'x86-box', arch: 'amd64' })]
    )
    assert.equal(eligible.length, 0)
    assert.equal(rejected[0]!.code, 'arch_incompatible')
    assert.match(rejected[0]!.detail, /amd64/)
    assert.match(rejected[0]!.detail, /arm64/)
  })

  test('an empty compatibleArches list means any architecture', () => {
    const { eligible } = filterNodes(svc({ compatibleArches: [] }), homelab())
    assert.equal(eligible.length, 5)
  })

  test('RAM is measured against what is uncommitted, not total', () => {
    const nodes = [node({ id: 'n1', name: 'busy', ramMb: 8192, committedRamMb: 8000 })]
    const { eligible, rejected } = filterNodes(svc({ requestRamMb: 512 }), nodes)
    assert.equal(eligible.length, 0)
    assert.equal(rejected[0]!.code, 'insufficient_ram')
    assert.match(rejected[0]!.detail, /192MB free of 8192MB/)
  })

  test('GPU requirement filters to GPU nodes', () => {
    const nodes = [node({ id: 'n1', name: 'cpu' }), node({ id: 'n2', name: 'gpu', hasGpu: true })]
    const { eligible } = filterNodes(svc({ requiresGpu: true }), nodes)
    assert.deepEqual(eligible.map((n) => n.id), ['n2'])
  })

  test('reliability tier is a floor, not a preference', () => {
    const { eligible } = filterNodes(svc({ minReliabilityTier: 'high' }), homelab())
    assert.deepEqual(eligible.map((n) => n.name).sort(), ['home-server', 'pi-5', 'vps-fra'])
  })

  test('required tags must all be present', () => {
    const nodes = [
      node({ id: 'n1', name: 'a', tags: ['office-network'] }),
      node({ id: 'n2', name: 'b', tags: ['office-network', 'low-power'] }),
    ]
    const { eligible } = filterNodes(svc({ requiredTags: ['office-network', 'low-power'] }), nodes)
    assert.deepEqual(eligible.map((n) => n.id), ['n2'])
  })
})

describe('affinity rules', () => {
  test('anti-affinity keeps replicas off the same node', () => {
    const nodes = [node({ id: 'n1', name: 'a' }), node({ id: 'n2', name: 'b' })]
    const { eligible, rejected } = filterNodes(
      svc({ name: 'web-2', antiAffinity: ['web-1'] }),
      nodes,
      { 'web-1': 'n1' }
    )
    assert.deepEqual(eligible.map((n) => n.id), ['n2'])
    assert.equal(rejected[0]!.code, 'anti_affinity')
  })

  test('affinity pulls a service onto its partner node', () => {
    const nodes = [node({ id: 'n1', name: 'a' }), node({ id: 'n2', name: 'b' })]
    const { eligible } = filterNodes(svc({ affinity: ['cache'] }), nodes, { cache: 'n2' })
    assert.deepEqual(eligible.map((n) => n.id), ['n2'])
  })

  test('affinity to an unplaced service does not block placement', () => {
    // Otherwise one service being down would cascade into its partner being
    // unschedulable too.
    const nodes = [node({ id: 'n1', name: 'a' }), node({ id: 'n2', name: 'b' })]
    const { eligible } = filterNodes(svc({ affinity: ['cache'] }), nodes, {})
    assert.equal(eligible.length, 2)
  })
})

describe('ranking (§8 step 2)', () => {
  test('prefers the node with more headroom, all else equal', () => {
    const nodes = [
      node({ id: 'n1', name: 'roomy', ramMb: 16384, loadFactor: 0.3, reliabilityTier: 'high' }),
      node({ id: 'n2', name: 'tight', ramMb: 2048, loadFactor: 0.3, reliabilityTier: 'high' }),
    ]
    assert.equal(rankNodes(svc(), nodes)[0]!.nodeName, 'roomy')
  })

  test('prefers a higher reliability tier when headroom matches', () => {
    const nodes = [
      node({ id: 'n1', name: 'flaky', reliabilityTier: 'opportunistic' }),
      node({ id: 'n2', name: 'solid', reliabilityTier: 'high' }),
    ]
    assert.equal(rankNodes(svc(), nodes)[0]!.nodeName, 'solid')
  })

  test('spreads load rather than piling onto a busy node', () => {
    const nodes = [
      node({ id: 'n1', name: 'busy', loadFactor: 0.95 }),
      node({ id: 'n2', name: 'idle', loadFactor: 0.05 }),
    ]
    assert.equal(rankNodes(svc(), nodes)[0]!.nodeName, 'idle')
  })

  test('scores are bounded and the weights sum to one', () => {
    const total = WEIGHTS.headroom + WEIGHTS.reliability + WEIGHTS.load
    assert.equal(total, 1)
    for (const c of rankNodes(svc(), homelab())) {
      assert.ok(c.score >= 0 && c.score <= 1, `score ${c.score} out of range`)
    }
  })

  test('an unknown load factor is treated as mid-range, not free', () => {
    // Assuming an unmeasured node is idle would make it win every time.
    const [known, unknown] = rankNodes(svc(), [
      node({ id: 'n1', name: 'known', loadFactor: 0.5 }),
      node({ id: 'n2', name: 'unknown', loadFactor: undefined }),
    ])
    assert.equal(known!.breakdown.load, unknown!.breakdown.load)
  })
})

describe('edge cases named in tech doc §12', () => {
  test('no eligible node returns an outcome, not an exception', () => {
    const decision = place(svc({ requestRamMb: 999_999 }), homelab())
    assert.equal(decision.outcome, 'no_eligible_node')
    assert.equal(decision.candidates.length, 0)
  })

  test('the failure explains itself per node, not just "no eligible node"', () => {
    // Built so that every node fails for a *different* reason: the point of
    // the test is that the report distinguishes them.
    const fleet = [
      node({ id: 'n1', name: 'home-server', ramMb: 16384, committedRamMb: 15000, reliabilityTier: 'high' }),
      node({ id: 'n2', name: 'pi-5', arch: 'arm64', ramMb: 8192, reliabilityTier: 'high' }),
      node({ id: 'n3', name: 'thinkpad', ramMb: 16384, reliabilityTier: 'opportunistic' }),
      node({ id: 'n4', name: 'vps-fra', ramMb: 2048, reliabilityTier: 'high' }),
      node({ id: 'n5', name: 'mini-pc', ramMb: 16384, reliabilityTier: 'high', status: 'cordoned' }),
    ]
    const decision = place(
      svc({ minReliabilityTier: 'high', requestRamMb: 4096, compatibleArches: ['amd64'] }),
      fleet
    )
    assert.equal(decision.outcome, 'no_eligible_node')
    if (decision.outcome !== 'no_eligible_node') return

    const byName = Object.fromEntries(decision.rejected.map((r) => [r.nodeName, r.code]))
    assert.equal(byName['home-server'], 'insufficient_ram', 'high tier but full')
    assert.equal(byName['pi-5'], 'arch_incompatible', 'right tier and RAM, wrong architecture')
    assert.equal(byName['thinkpad'], 'reliability_too_low', 'plenty of room, not trusted enough')
    assert.equal(byName['vps-fra'], 'insufficient_ram', 'trusted but small')
    assert.equal(byName['mini-pc'], 'cordoned', 'would fit, but excluded on purpose')

    assert.match(decision.summary, /No eligible node for "web" among 5/)
    assert.match(decision.summary, /insufficient ram/)
  })

  test('tied scores resolve deterministically across repeated runs', () => {
    const tied = [
      node({ id: 'b-node', name: 'b', ramMb: 8192, loadFactor: 0.4 }),
      node({ id: 'a-node', name: 'a', ramMb: 8192, loadFactor: 0.4 }),
      node({ id: 'c-node', name: 'c', ramMb: 8192, loadFactor: 0.4 }),
    ]
    const first = place(svc(), tied)
    assert.equal(first.outcome, 'placed')
    for (let i = 0; i < 20; i++) {
      const again = place(svc(), [...tied].reverse())
      assert.equal(again.outcome === 'placed' && again.nodeId, 'a-node', 'must not flap between runs')
    }
  })

  test('a node going down mid-placement is simply excluded on the re-run', () => {
    const nodes = homelab()
    const first = place(svc({ compatibleArches: ['amd64'] }), nodes)
    assert.equal(first.outcome, 'placed')
    if (first.outcome !== 'placed') return
    assert.equal(first.nodeName, 'home-server')

    // Same call, with the winner now offline — the failover path.
    const after = nodes.map((n) => (n.id === first.nodeId ? { ...n, status: 'offline' as const } : n))
    const second = place(svc({ compatibleArches: ['amd64'] }), after)
    assert.equal(second.outcome, 'placed')
    if (second.outcome !== 'placed') return
    assert.notEqual(second.nodeId, first.nodeId)
    assert.equal(second.nodeName, 'vps-fra')
  })

  test('an empty fleet says so plainly', () => {
    const decision = place(svc(), [])
    assert.equal(decision.outcome, 'no_eligible_node')
    if (decision.outcome !== 'no_eligible_node') return
    assert.match(decision.summary, /No nodes in this fleet/)
  })
})

describe('placement policies', () => {
  test('a pinned service only ever lands on its node', () => {
    const decision = place(svc({ placementPolicy: 'pinned', pinnedNodeId: 'n3' }), homelab())
    assert.equal(decision.outcome, 'placed')
    if (decision.outcome !== 'placed') return
    assert.equal(decision.nodeName, 'thinkpad')
    assert.equal(decision.candidates.length, 1, 'nothing else should be a candidate')
  })

  test('a pinned service whose node is down does not silently move (FR-7)', () => {
    const nodes = homelab().map((n) => (n.id === 'n3' ? { ...n, status: 'offline' as const } : n))
    const decision = place(svc({ placementPolicy: 'pinned', pinnedNodeId: 'n3' }), nodes)
    assert.equal(decision.outcome, 'no_eligible_node')
  })

  test('a pinned service with no node named is a config error', () => {
    const decision = place(svc({ placementPolicy: 'pinned', pinnedNodeId: null }), homelab())
    assert.equal(decision.outcome, 'no_eligible_node')
    if (decision.outcome !== 'no_eligible_node') return
    assert.match(decision.summary, /pinned but names no node/)
  })

  test('a volume anchors a service even when the policy says flexible', () => {
    const decision = place(
      svc({ persistentVolume: true, volumeNodeId: 'n2' }),
      homelab()
    )
    assert.equal(decision.outcome, 'placed')
    if (decision.outcome !== 'placed') return
    assert.equal(decision.nodeId, 'n2')
  })

  test('FR-18: flexible placement with a volume warns rather than silently allowing it', () => {
    const decision = place(svc({ persistentVolume: true, placementPolicy: 'flexible' }), homelab())
    assert.equal(decision.warnings.length, 1)
    assert.match(decision.warnings[0]!, /Data does not move between machines/)
  })
})

describe('non-functional requirements', () => {
  test('placement for a 25-node fleet resolves well under 2 seconds (§9)', () => {
    const fleet = Array.from({ length: 25 }, (_, i) =>
      node({
        id: `n${i}`,
        name: `node-${i}`,
        arch: i % 3 === 0 ? 'arm64' : 'amd64',
        ramMb: 2048 * ((i % 4) + 1),
        committedRamMb: i * 40,
        reliabilityTier: (['opportunistic', 'standard', 'high'] as const)[i % 3]!,
        loadFactor: (i % 10) / 10,
      })
    )
    const started = performance.now()
    for (let i = 0; i < 100; i++) place(svc({ requestRamMb: 512 }), fleet)
    const perDecision = (performance.now() - started) / 100

    assert.ok(perDecision < 2000, `${perDecision}ms per decision`)
    // The NFR allows 2s; anything near that would mean something is wrong.
    assert.ok(perDecision < 50, `${perDecision.toFixed(3)}ms per decision — unexpectedly slow`)
  })
})

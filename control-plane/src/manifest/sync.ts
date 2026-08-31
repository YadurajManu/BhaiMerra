import { and, eq, inArray, notInArray } from 'drizzle-orm'
import { managedHostname } from '../ingress/routes.js'
import { services, nodes, fleets } from '../db/schema.js'
import { recordAudit } from '../lib/audit.js'
import { ApiError } from '../api/errors.js'
import type { AppContext } from '../api/context.js'
import type { ParsedManifest } from './parse.js'

const TIER = { any: 'opportunistic', opportunistic: 'opportunistic', standard: 'standard', high: 'high' } as const

export type SyncResult = {
  created: string[]
  updated: string[]
  /** In the fleet but no longer in the manifest — reported, never deleted. */
  orphaned: string[]
  warnings: string[]
}

/**
 * Reconcile a fleet's services with a parsed manifest.
 *
 * Services that vanish from the manifest are reported as orphaned rather than
 * deleted: a typo in a service name would otherwise silently destroy a running
 * service and its volume. Removal stays an explicit action.
 */
export async function syncManifest(
  ctx: AppContext,
  fleetId: string,
  orgId: string,
  manifest: ParsedManifest,
  actorUserId?: string
): Promise<SyncResult> {
  const [fleet] = await ctx.db
    .select({ name: fleets.name })
    .from(fleets)
    .where(eq(fleets.id, fleetId))
    .limit(1)
  const fleetName = fleet?.name ?? 'fleet'
  const zone = ctx.config.INGRESS_ZONE

  const fleetNodes = await ctx.db
    .select({ id: nodes.id, name: nodes.name })
    .from(nodes)
    .where(eq(nodes.fleetId, fleetId))
  const nodeByName = new Map(fleetNodes.map((n) => [n.name, n.id]))

  // Resolve pinned node names before writing anything, so a manifest naming a
  // node that does not exist fails whole rather than half-applied.
  const unresolved = manifest.services
    .filter((s) => s.node && !nodeByName.has(s.node))
    .map((s) => `services.${s.name}.node: no node named "${s.node}" in this fleet`)
  if (unresolved.length) {
    throw ApiError.unprocessable('unknown_node', 'The manifest names nodes that are not in this fleet', unresolved)
  }

  const existing = await ctx.db.select().from(services).where(eq(services.fleetId, fleetId))
  const existingByName = new Map(existing.map((s) => [s.name, s]))

  const created: string[] = []
  const updated: string[] = []

  await ctx.db.transaction(async (tx) => {
    for (const svc of manifest.services) {
      const values = {
        fleetId,
        name: svc.name,
        repoUrl: svc.repo ?? null,
        buildContext: svc.build ?? null,
        image: svc.image ?? null,
        placementPolicy: svc.placement,
        pinnedNodeId: svc.node ? nodeByName.get(svc.node)! : null,
        requestRamMb: svc.resources.ram,
        requestCpu: String(svc.resources.cpu),
        requiresGpu: svc.gpu,
        minReliabilityTier: TIER[svc.min_reliability],
        compatibleArches: svc.arch,
        affinity: svc.affinity,
        antiAffinity: svc.anti_affinity,
        persistentVolume: Boolean(svc.volume),
        volumeName: svc.volume ?? null,
        replicas: svc.replicas,
        healthCheckPath: svc.health.path,
        // Both of these were parsed and then dropped on the floor, which is why
        // a manifest could declare configuration that never reached anything.
        // Values are coerced to strings because YAML happily produces numbers
        // and booleans, and an environment variable is always a string.
        env: Object.fromEntries(Object.entries(svc.env).map(([k, v]) => [k, String(v)])),
        secretRefs: svc.secrets,
        domain: svc.domain ?? null,
        containerPort: svc.port,
        internal: svc.internal,
        // Every public service gets a managed hostname whether or not it brings
        // its own domain, so there is always a URL to hand back after a deploy.
        // An internal service gets none: a name that resolves publicly is
        // exactly what it is asking not to have.
        hostname: svc.internal ? null : managedHostname(svc.name, fleetName, fleetId, zone),
        reclaimPolicy: svc.reclaim ?? null,
      }

      const prior = existingByName.get(svc.name)
      if (prior) {
        await tx.update(services).set(values).where(eq(services.id, prior.id))
        updated.push(svc.name)
      } else {
        await tx.insert(services).values(values)
        created.push(svc.name)
      }
    }

    await recordAudit(tx, {
      orgId,
      actorUserId,
      action: 'service.manifest_applied',
      targetType: 'fleet',
      targetId: fleetId,
      metadata: { created, updated, services: manifest.services.length },
    })
  })

  const declared = new Set(manifest.services.map((s) => s.name))
  const orphaned = existing.filter((s) => !declared.has(s.name)).map((s) => s.name)

  const warnings = [...manifest.warnings]
  if (orphaned.length) {
    warnings.push(
      `${orphaned.join(', ')} ${orphaned.length === 1 ? 'is' : 'are'} no longer in fleet.yaml but still ` +
        `${orphaned.length === 1 ? 'exists' : 'exist'} in the fleet. Nothing was deleted — remove ` +
        `${orphaned.length === 1 ? 'it' : 'them'} explicitly if that was intended.`
    )
  }

  return { created, updated, orphaned, warnings }
}

import { randomBytes } from 'node:crypto'
import { and, eq, inArray, notInArray } from 'drizzle-orm'
import { ENGINES, passwordRefFor } from './databases.js'
import { hasSecret, setSecret } from '../secrets/store.js'
import { managedHostname } from '../ingress/routes.js'
import { services, nodes, fleets } from '../db/schema.js'
import { recordAudit } from '../lib/audit.js'
import { ApiError } from '../api/errors.js'
import type { AppContext } from '../api/context.js'
import type { ParsedManifest } from './parse.js'

const TIER = { any: 'opportunistic', opportunistic: 'opportunistic', standard: 'standard', high: 'high' } as const

export type SyncResult = {
  /** The project these services now belong to. */
  project: string
  created: string[]
  updated: string[]
  /** In the fleet but no longer in the manifest — reported, never deleted. */
  orphaned: string[]
  warnings: string[]
  /** Database credentials created by this apply, by name. Never the values. */
  generatedSecrets: string[]
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
  actorUserId?: string,
  /**
   * What to call this manifest's services when it does not name itself. The
   * CLI passes the directory name, the way Compose does; the webhook passes
   * the repository. Falls back to 'default' so nothing has to supply one.
   */
  fallbackProject?: string
): Promise<SyncResult> {
  const project = manifest.project ?? fallbackProject ?? 'default'
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

  /* ── credentials for managed databases ──────────────────────────
     Generated once, on the first apply that declares the database, and
     never regenerated: the password is written into the engine's data
     directory at initialisation, so changing it later would lock the
     application out of a database that is working perfectly.

     This is also why they are generated rather than asked for. The value
     has to be identical in two places — what the engine is created with,
     and what the client connects with — and a person typing it twice is
     exactly how those two drift apart. */
  const createdSecrets: string[] = []
  for (const db of manifest.databases) {
    const spec = ENGINES[db.engine]
    if (!spec?.usesPassword) continue
    const key = passwordRefFor(db.name)
    if (await hasSecret(ctx, { fleetId }, key)) continue
    // base64url of 24 random bytes: no shell-special characters, nothing that
    // needs escaping in a connection string, and 192 bits of entropy.
    const value = randomBytes(24).toString('base64url')
    await setSecret(ctx, { fleetId }, key, value)
    createdSecrets.push(key)
  }

  const existing = await ctx.db.select().from(services).where(eq(services.fleetId, fleetId))
  const existingByName = new Map(existing.map((s) => [s.name, s]))

  const created: string[] = []
  const updated: string[] = []

  await ctx.db.transaction(async (tx) => {
    for (const svc of manifest.services) {
      const values = {
        fleetId,
        project,
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
        volumePath: svc.volumePath ?? null,
        replicas: svc.replicas,
        backupSchedule: svc.backup ?? null,
        healthCheckPath: svc.health.path,
        healthIntervalSec: svc.health.interval,
        healthTimeoutSec: svc.health.timeout,
        healthDisabled: svc.health.disabled,
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
      metadata: { project, created, updated, services: manifest.services.length },
    })
  })

  // Scoped to this project. Computed across the whole fleet, "no longer in
  // fleet.yaml" warned about every service belonging to somebody else's
  // manifest — which is not a thing this apply could possibly have removed.
  const declared = new Set(manifest.services.map((s) => s.name))
  const orphaned = existing
    .filter((s) => s.project === project && !declared.has(s.name))
    .map((s) => s.name)

  const warnings = [...manifest.warnings]
  if (orphaned.length) {
    warnings.push(
      `${orphaned.join(', ')} ${orphaned.length === 1 ? 'is' : 'are'} no longer in the "${project}" ` +
        `manifest but still ${orphaned.length === 1 ? 'exists' : 'exist'} in the fleet. Nothing was ` +
        `deleted — remove ${orphaned.length === 1 ? 'it' : 'them'} explicitly if that was intended.`
    )
  }

  // Said out loud, because a credential that appears without being asked for
  // is surprising even when it is what you wanted — and because it is the
  // user's to rotate, back up, or replace.
  if (createdSecrets.length) {
    warnings.push(
      `Generated ${createdSecrets.join(', ')} for the databases in this manifest. ` +
        `The values are stored encrypted and are never shown; a database keeps the password it was ` +
        `created with, so replacing one means recreating that database.`
    )
  }

  return { project, created, updated, orphaned, warnings, generatedSecrets: createdSecrets }
}

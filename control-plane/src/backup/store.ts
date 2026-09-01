import { createHash, randomUUID } from 'node:crypto'
import { mkdir, rm, stat, writeFile } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { and, desc, eq, inArray, lt } from 'drizzle-orm'
import { backups, deployments, services } from '../db/schema.js'
import { ApiError } from '../api/errors.js'
import type { AppContext } from '../api/context.js'

/**
 * Where backup archives live, and the rules about them.
 *
 * The archives are files rather than rows: a database volume is measured in
 * gigabytes and Postgres is the wrong place to keep one. The table records
 * what exists, what it weighs, and whether it can be trusted; the bytes sit on
 * disk beside it.
 */

export type BackupRow = typeof backups.$inferSelect

/**
 * A backup is only meaningful for a service that has a volume.
 *
 * Everything else is reproducible from its image and manifest, so "backing up"
 * a stateless service would produce an archive of an empty directory and imply
 * a safety it does not provide.
 */
export function assertBackable(service: {
  name: string
  persistentVolume: boolean
  volumeName: string | null
}): string {
  if (!service.persistentVolume || !service.volumeName) {
    throw ApiError.unprocessable(
      'nothing_to_back_up',
      `"${service.name}" has no volume. Its image and manifest already describe everything it holds, ` +
        `so there is nothing a backup could capture that a redeploy would not.`
    )
  }
  return service.volumeName
}

/** The archive's path, relative to the backup root. */
export function artifactName(backupId: string): string {
  return `${backupId}.tar.gz`
}

/**
 * Resolve a stored path inside the backup root, refusing anything that escapes.
 *
 * The id comes from a URL. Without this, `../../etc/passwd` reads a file the
 * control plane should never serve, and a crafted upload writes one.
 */
export function artifactPath(root: string, name: string): string {
  const base = resolve(root)
  const full = resolve(base, name)
  if (full !== base && !full.startsWith(base + sep)) {
    throw ApiError.badRequest('bad_artifact_path', 'That backup path is not inside the backup directory')
  }
  return full
}

/**
 * Ask for a backup.
 *
 * Creates the job and stops. The node holding the volume is the only thing
 * that can read it — the control plane never touches a node's disk — so the
 * work happens when that node next polls, and this returns immediately rather
 * than holding a request open for however long a few gigabytes takes.
 */
export async function requestBackup(
  ctx: AppContext,
  service: { id: string; name: string; persistentVolume: boolean; volumeName: string | null },
  opts: { scheduled?: boolean; userId?: string } = {}
): Promise<BackupRow> {
  const volume = assertBackable(service)

  // Whichever node is currently running it holds the volume. A service with no
  // live deployment has one somewhere, but nothing is reporting from there.
  const [live] = await ctx.db
    .select({ nodeId: deployments.nodeId })
    .from(deployments)
    .where(
      and(eq(deployments.serviceId, service.id), inArray(deployments.status, ['running', 'deploying']))
    )
    .orderBy(desc(deployments.startedAt))
    .limit(1)

  if (!live?.nodeId) {
    throw ApiError.unprocessable(
      'not_running',
      `"${service.name}" is not running anywhere, so no node can be asked to read its volume. ` +
        `Deploy it first — the data is still on whichever machine last ran it.`
    )
  }

  // One at a time. Two tar processes over one volume is wasted IO on a
  // machine that is also serving, and the second archive is not more correct.
  const [existing] = await ctx.db
    .select({ id: backups.id })
    .from(backups)
    .where(and(eq(backups.serviceId, service.id), inArray(backups.status, ['pending', 'running'])))
    .limit(1)
  if (existing) {
    throw ApiError.unprocessable(
      'already_running',
      `A backup of "${service.name}" is already in progress.`
    )
  }

  const [row] = await ctx.db
    .insert(backups)
    .values({
      serviceId: service.id,
      nodeId: live.nodeId,
      volumeRef: volume,
      status: 'pending',
      scheduled: opts.scheduled ?? false,
      requestedByUserId: opts.userId ?? null,
    })
    .returning()
  return row!
}

/** Backups a node should be getting on with. */
export async function pendingForNode(ctx: AppContext, nodeId: string): Promise<
  Array<{ id: string; volume: string; serviceName: string }>
> {
  const rows = await ctx.db
    .select({ id: backups.id, volume: backups.volumeRef, serviceName: services.name })
    .from(backups)
    .innerJoin(services, eq(services.id, backups.serviceId))
    .where(and(eq(backups.nodeId, nodeId), eq(backups.status, 'pending')))
    .orderBy(backups.createdAt)
    .limit(3)
  return rows
}

/**
 * Store an uploaded archive and complete the job.
 *
 * The checksum is computed here rather than trusted from the node: it is what
 * a later restore is checked against, and a value supplied by the same party
 * that supplied the bytes proves nothing about them.
 */
export async function completeBackup(
  ctx: AppContext,
  backupId: string,
  archive: Buffer
): Promise<BackupRow> {
  const root = ctx.config.BACKUP_DIR
  await mkdir(root, { recursive: true })

  const name = artifactName(backupId)
  const full = artifactPath(root, name)
  await writeFile(full, archive)

  const checksum = createHash('sha256').update(archive).digest('hex')
  const { size } = await stat(full)

  const [row] = await ctx.db
    .update(backups)
    .set({
      status: 'complete',
      storageLocation: name,
      sizeBytes: size,
      checksum,
      finishedAt: new Date(),
      failureReason: null,
    })
    .where(eq(backups.id, backupId))
    .returning()
  return row!
}

export async function failBackup(ctx: AppContext, backupId: string, reason: string): Promise<void> {
  await ctx.db
    .update(backups)
    .set({ status: 'failed', failureReason: reason.slice(0, 2000), finishedAt: new Date() })
    .where(eq(backups.id, backupId))
}

export async function markRunning(ctx: AppContext, backupId: string): Promise<void> {
  await ctx.db
    .update(backups)
    .set({ status: 'running', startedAt: new Date() })
    .where(and(eq(backups.id, backupId), eq(backups.status, 'pending')))
}

/**
 * A backup that was claimed and never finished.
 *
 * A node that dies mid-archive leaves the row `running` forever, and the
 * one-at-a-time rule above then blocks every future backup of that service —
 * a stall that presents as "backups silently stopped working".
 */
export const BACKUP_TIMEOUT_MS = 30 * 60_000

export async function failStalledBackups(ctx: AppContext): Promise<string[]> {
  const cutoff = new Date(Date.now() - BACKUP_TIMEOUT_MS)
  const stalled = await ctx.db
    .update(backups)
    .set({
      status: 'failed',
      failureReason: 'the node stopped reporting before the archive arrived',
      finishedAt: new Date(),
    })
    .where(and(eq(backups.status, 'running'), lt(backups.startedAt, cutoff)))
    .returning({ id: backups.id })
  return stalled.map((r) => r.id)
}

/** Delete a backup and its archive. The row goes last, so nothing is orphaned. */
export async function deleteBackup(ctx: AppContext, row: BackupRow): Promise<void> {
  if (row.storageLocation) {
    await rm(artifactPath(ctx.config.BACKUP_DIR, row.storageLocation), { force: true }).catch(() => {})
  }
  await ctx.db.delete(backups).where(eq(backups.id, row.id))
}

/** A stable id for an archive that has not been written yet. */
export const newArtifactId = () => randomUUID()

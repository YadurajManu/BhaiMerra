import { createReadStream } from 'node:fs'
import { and, desc, eq } from 'drizzle-orm'
import { z } from 'zod'
import type { FastifyInstance } from 'fastify'
import { backups, services } from '../db/schema.js'
import {
  artifactPath,
  completeBackup,
  deleteBackup,
  failBackup,
  markRunning,
  requestBackup,
} from '../backup/store.js'
import { recordAudit } from '../lib/audit.js'
import { ApiError } from './errors.js'
import { requireAgent, requireFleetPermission } from './guards.js'

/**
 * Backups: asking for one, listing them, and the node's side of the exchange.
 *
 * The control plane never reads a node's disk — nodes make outbound
 * connections only, which is the whole design. So a backup is a job the node
 * collects, performs, and uploads the result of.
 */
export async function backupRoutes(app: FastifyInstance) {
  const { db } = app.ctx

  /** A tar.gz of a volume. Fastify has no parser for it. */
  app.addContentTypeParser(
    'application/octet-stream',
    { parseAs: 'buffer', bodyLimit: 8 * 1024 * 1024 * 1024 },
    (_req, body, done) => done(null, body)
  )

  const loadService = async (serviceId: string, fleetId: string) => {
    const [service] = await db
      .select()
      .from(services)
      .where(and(eq(services.id, serviceId), eq(services.fleetId, fleetId)))
      .limit(1)
    if (!service) throw ApiError.notFound('Service')
    return service
  }

  /* ── people ──────────────────────────────────────────────────── */

  app.post(
    '/fleets/:fleetId/services/:serviceId/backups',
    { preHandler: requireFleetPermission('service.deploy') },
    async (req, reply) => {
      const { fleetId, serviceId } = req.params as { fleetId: string; serviceId: string }
      const service = await loadService(serviceId, fleetId)
      const row = await requestBackup(app.ctx, service, { userId: req.userId })

      await recordAudit(db, {
        orgId: req.orgId!,
        actorUserId: req.userId,
        action: 'backup.requested',
        targetType: 'service',
        targetId: service.id,
        metadata: { backup: row.id, volume: row.volumeRef },
      })

      return reply.code(202).send({
        backup: row,
        note: 'Queued. The node holding the volume performs it on its next poll.',
      })
    }
  )

  app.get(
    '/fleets/:fleetId/services/:serviceId/backups',
    { preHandler: requireFleetPermission('service.read') },
    async (req) => {
      const { fleetId, serviceId } = req.params as { fleetId: string; serviceId: string }
      await loadService(serviceId, fleetId)
      const rows = await db
        .select()
        .from(backups)
        .where(eq(backups.serviceId, serviceId))
        .orderBy(desc(backups.createdAt))
        .limit(50)
      return { backups: rows }
    }
  )

  /** Download an archive. The only way the bytes leave the control plane. */
  app.get(
    '/fleets/:fleetId/backups/:backupId/archive',
    { preHandler: requireFleetPermission('service.deploy') },
    async (req, reply) => {
      const { fleetId, backupId } = req.params as { fleetId: string; backupId: string }
      const [row] = await db
        .select({ backup: backups })
        .from(backups)
        .innerJoin(services, eq(services.id, backups.serviceId))
        .where(and(eq(backups.id, backupId), eq(services.fleetId, fleetId)))
        .limit(1)
      if (!row) throw ApiError.notFound('Backup')
      if (row.backup.status !== 'complete' || !row.backup.storageLocation) {
        throw ApiError.unprocessable(
          'not_complete',
          `That backup is ${row.backup.status}; there is no archive to download yet.`
        )
      }

      const full = artifactPath(app.ctx.config.BACKUP_DIR, row.backup.storageLocation)
      return reply
        .header('content-type', 'application/gzip')
        .header('content-disposition', `attachment; filename="${row.backup.id}.tar.gz"`)
        .send(createReadStream(full))
    }
  )

  app.delete(
    '/fleets/:fleetId/backups/:backupId',
    { preHandler: requireFleetPermission('service.deploy') },
    async (req) => {
      const { fleetId, backupId } = req.params as { fleetId: string; backupId: string }
      const [row] = await db
        .select({ backup: backups })
        .from(backups)
        .innerJoin(services, eq(services.id, backups.serviceId))
        .where(and(eq(backups.id, backupId), eq(services.fleetId, fleetId)))
        .limit(1)
      if (!row) throw ApiError.notFound('Backup')

      await deleteBackup(app.ctx, row.backup)
      return { removed: row.backup.id }
    }
  )

  /* ── nodes ───────────────────────────────────────────────────── */

  /**
   * The node has started reading the volume.
   *
   * Claimed rather than assumed: without this the control plane cannot tell a
   * backup that is running from one whose node never picked it up, and the
   * stall sweeper would have nothing to measure.
   */
  app.post('/agent/backups/:backupId/claim', { preHandler: requireAgent }, async (req) => {
    const { backupId } = req.params as { backupId: string }
    const [row] = await db
      .select()
      .from(backups)
      .where(and(eq(backups.id, backupId), eq(backups.nodeId, req.agentNodeId!)))
      .limit(1)
    if (!row) throw ApiError.notFound('Backup')
    await markRunning(app.ctx, backupId)
    return { ok: true }
  })

  /** The archive itself. */
  app.post(
    '/agent/backups/:backupId',
    { preHandler: requireAgent, bodyLimit: 8 * 1024 * 1024 * 1024 },
    async (req) => {
      const { backupId } = req.params as { backupId: string }
      const [row] = await db
        .select()
        .from(backups)
        .where(and(eq(backups.id, backupId), eq(backups.nodeId, req.agentNodeId!)))
        .limit(1)
      // Scoped to the reporting node: a backup belongs to the machine holding
      // the volume, and any other node uploading for it is either a bug or
      // someone replacing an archive they should not be able to reach.
      if (!row) throw ApiError.notFound('Backup')

      const archive = req.body
      if (!Buffer.isBuffer(archive) || !archive.length) {
        await failBackup(app.ctx, backupId, 'the node uploaded an empty archive')
        throw ApiError.unprocessable('empty_archive', 'The uploaded archive was empty')
      }

      const done = await completeBackup(app.ctx, backupId, archive)
      req.log.info(
        { backupId, bytes: done.sizeBytes, volume: done.volumeRef },
        'backup archive stored'
      )
      return { ok: true, sizeBytes: done.sizeBytes, checksum: done.checksum }
    }
  )

  /** The node could not do it, and says why. */
  app.post('/agent/backups/:backupId/fail', { preHandler: requireAgent }, async (req) => {
    const { backupId } = req.params as { backupId: string }
    const body = z.object({ reason: z.string().max(4000) }).parse(req.body ?? {})
    const [row] = await db
      .select({ id: backups.id })
      .from(backups)
      .where(and(eq(backups.id, backupId), eq(backups.nodeId, req.agentNodeId!)))
      .limit(1)
    if (!row) throw ApiError.notFound('Backup')

    await failBackup(app.ctx, backupId, body.reason)
    req.log.warn({ backupId, reason: body.reason }, 'node reported a failed backup')
    return { ok: true }
  })
}

/**
 * Volume backups.
 *
 * A volume is the one thing Fleet cannot reproduce. An image rebuilds from a
 * commit and a container recreates from a manifest; the bytes in a database's
 * data directory exist on exactly one disk, in one machine, and until now
 * there was no way to copy them anywhere.
 *
 * A backup is a job before it is an artifact, so most of what matters here is
 * what happens to the job — claimed, uploaded, failed, or abandoned by a node
 * that stopped reporting.
 */
import 'dotenv/config'
import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'

import { loadConfig } from '../src/config.js'
import { createContext, closeContext, type AppContext } from '../src/api/context.js'
import { buildServer } from '../src/server.js'
import { orgs, users, services, deployments, nodes, backups, restores } from '../src/db/schema.js'
import {
  artifactPath,
  assertBackable,
  completeBackup,
  failStalledBackups,
  pendingForNode,
  requestBackup,
  requestRestore,
  restoresForNode,
  BACKUP_TIMEOUT_MS,
} from '../src/backup/store.js'
import { intervalFor } from '../src/backup/schedule.js'
import { ApiError } from '../src/api/errors.js'

describe('backing up a volume', () => {
  let ctx: AppContext
  let app: FastifyInstance
  let root: string
  let fleetId: string
  let orgId: string
  let userId: string
  let nodeId: string
  let stateful: typeof services.$inferSelect
  let stateless: typeof services.$inferSelect

  before(async () => {
    root = await mkdtemp(join(tmpdir(), 'fleet-backup-test-'))
    ctx = createContext(loadConfig({ ...process.env, BACKUP_DIR: root }))
    app = await buildServer(ctx)

    const signup = await app.inject({
      method: 'POST',
      url: '/auth/signup',
      payload: { email: `backup-${Date.now()}@example.test`, password: 'a-long-enough-password' },
    })
    const body = signup.json()
    fleetId = body.fleet.id
    orgId = body.org.id
    userId = body.user.id

    const [n] = await ctx.db
      .insert(nodes)
      .values({
        fleetId,
        name: 'holder',
        arch: 'amd64',
        os: 'linux',
        cpuCores: 4,
        ramMb: 8192,
        diskMb: 100_000,
        status: 'online',
        agentTokenHash: `bh-${Date.now()}`,
        advertiseAddr: '10.0.0.9',
        lastHeartbeatAt: new Date(),
      })
      .returning()
    nodeId = n!.id

    const mk = async (name: string, volume: string | null) => {
      const [svc] = await ctx.db
        .insert(services)
        .values({
          fleetId,
          name,
          project: 'test',
          image: 'postgres:16-alpine',
          requestRamMb: 256,
          requestCpu: '0.25',
          containerPort: 5432,
          hostname: `${name}-b.example`,
          persistentVolume: Boolean(volume),
          volumeName: volume,
        })
        .returning()
      return svc!
    }
    stateful = await mk('db', 'db-data')
    stateless = await mk('web', null)

    await ctx.db.insert(deployments).values({
      serviceId: stateful.id,
      nodeId,
      status: 'running',
      imageTags: ['postgres:16-alpine'],
    })
  })

  after(async () => {
    await app.close()
    await ctx.db.delete(orgs).where(eq(orgs.id, orgId))
    await ctx.db.delete(users).where(eq(users.id, userId))
    await closeContext(ctx)
    await rm(root, { recursive: true, force: true })
  })

  test('a service with no volume has nothing to back up, and says why', () => {
    // Producing an archive of an empty directory would imply a safety it does
    // not provide.
    assert.throws(
      () => assertBackable({ name: 'web', persistentVolume: false, volumeName: null }),
      (err: unknown) => {
        assert.ok(err instanceof ApiError)
        assert.match(err.message, /redeploy would not/)
        return true
      }
    )
  })

  test('requesting one creates a job for the node holding the volume', async () => {
    const row = await requestBackup(ctx, stateful, { userId })
    assert.equal(row.status, 'pending')
    assert.equal(row.nodeId, nodeId, 'the job belongs to the node with the disk')
    assert.equal(row.volumeRef, 'db-data')
  })

  test('the node is handed its pending jobs', async () => {
    const jobs = await pendingForNode(ctx, nodeId)
    assert.equal(jobs.length, 1)
    assert.equal(jobs[0]!.volume, 'db-data')
    assert.equal(jobs[0]!.serviceName, 'db')
  })

  test('only one backup of a service runs at a time', async () => {
    // Two tar processes over one volume is wasted IO on a machine that is also
    // serving, and the second archive is not more correct than the first.
    await assert.rejects(
      () => requestBackup(ctx, stateful, { userId }),
      (err: unknown) => err instanceof ApiError && /already in progress/.test(err.message)
    )
  })

  test('a service that is not running has no node to ask', async () => {
    // The data is still on whichever machine last ran it, but nothing is
    // reporting from there — so say that rather than queueing a job forever.
    await assert.rejects(
      () => requestBackup(ctx, { ...stateless, persistentVolume: true, volumeName: 'x' }),
      (err: unknown) => err instanceof ApiError && /not running anywhere/.test(err.message)
    )
  })

  test('uploading the archive completes the job and checksums it', async () => {
    const [job] = await ctx.db.select().from(backups).where(eq(backups.serviceId, stateful.id))
    const archive = Buffer.from('a pretend tar.gz of a volume')

    const done = await completeBackup(ctx, job!.id, archive)
    assert.equal(done.status, 'complete')
    assert.equal(done.sizeBytes, archive.length)
    // Computed here rather than trusted from the node: a checksum supplied by
    // the same party that supplied the bytes proves nothing about them.
    assert.equal(done.checksum, createHash('sha256').update(archive).digest('hex'))

    const onDisk = await readFile(join(root, done.storageLocation!))
    assert.deepEqual(onDisk, archive, 'the stored bytes should be the uploaded bytes')
  })

  test('a completed backup frees the service for another', async () => {
    const again = await requestBackup(ctx, stateful, { userId })
    assert.equal(again.status, 'pending')
  })

  test('a backup whose node went quiet is failed, not left running', async () => {
    // Otherwise the row stays `running` forever and the one-at-a-time rule
    // blocks every future backup of that service — a stall that presents as
    // "backups silently stopped working".
    const [job] = await ctx.db
      .select()
      .from(backups)
      .where(eq(backups.status, 'pending'))
      .limit(1)
    await ctx.db
      .update(backups)
      .set({ status: 'running', startedAt: new Date(Date.now() - BACKUP_TIMEOUT_MS - 60_000) })
      .where(eq(backups.id, job!.id))

    const failed = await failStalledBackups(ctx)
    assert.ok(failed.includes(job!.id))

    const [after] = await ctx.db.select().from(backups).where(eq(backups.id, job!.id))
    assert.equal(after!.status, 'failed')
    assert.match(after!.failureReason!, /stopped reporting/)
  })
})

describe('artifact paths', () => {
  test('a stored path cannot escape the backup directory', () => {
    // The id arrives in a URL. Without this, `../../etc/passwd` reads a file
    // the control plane should never serve, and a crafted upload writes one.
    const root = '/var/lib/fleet-os/backups'
    assert.equal(artifactPath(root, 'abc.tar.gz'), `${root}/abc.tar.gz`)
    assert.throws(() => artifactPath(root, '../../etc/passwd'), ApiError)
    assert.throws(() => artifactPath(root, '/etc/passwd'), ApiError)
    assert.throws(() => artifactPath(root, 'a/../../../outside'), ApiError)
  })

  test('a path that merely starts with the root string is still outside it', () => {
    // "/var/lib/fleet-os/backups-evil" begins with the root but is a sibling
    // directory, and a plain startsWith would have accepted it.
    assert.throws(() => artifactPath('/var/lib/fleet-os/backups', '../backups-evil/x'), ApiError)
  })
})

describe('putting a backup back', () => {
  let ctx: AppContext
  let app: FastifyInstance
  let root: string
  let fleetId: string
  let orgId: string
  let userId: string
  let nodeId: string
  let service: typeof services.$inferSelect
  let backup: typeof backups.$inferSelect

  before(async () => {
    root = await mkdtemp(join(tmpdir(), 'fleet-restore-test-'))
    ctx = createContext(loadConfig({ ...process.env, BACKUP_DIR: root }))
    app = await buildServer(ctx)

    const signup = await app.inject({
      method: 'POST',
      url: '/auth/signup',
      payload: { email: `restore-${Date.now()}@example.test`, password: 'a-long-enough-password' },
    })
    const body = signup.json()
    fleetId = body.fleet.id
    orgId = body.org.id
    userId = body.user.id

    const [n] = await ctx.db
      .insert(nodes)
      .values({
        fleetId, name: 'holder', arch: 'amd64', os: 'linux',
        cpuCores: 4, ramMb: 8192, diskMb: 100_000, status: 'online',
        agentTokenHash: `rh-${Date.now()}`, advertiseAddr: '10.0.0.9', lastHeartbeatAt: new Date(),
      })
      .returning()
    nodeId = n!.id

    const [svc] = await ctx.db
      .insert(services)
      .values({
        fleetId, name: 'db', project: 'test', image: 'postgres:16-alpine',
        requestRamMb: 256, requestCpu: '0.25', containerPort: 5432,
        hostname: 'db-r.example', persistentVolume: true, volumeName: 'db-data',
      })
      .returning()
    service = svc!

    // A completed backup, and a deployment that has since been superseded —
    // which is the state a service is in when you actually want a restore.
    await ctx.db.insert(deployments).values({
      serviceId: service.id, nodeId, status: 'superseded',
      imageTags: ['postgres:16-alpine'],
    })
    const [b] = await ctx.db
      .insert(backups)
      .values({
        serviceId: service.id, nodeId, volumeRef: 'db-data',
        status: 'complete', storageLocation: 'x.tar.gz', sizeBytes: 10, checksum: 'abc',
      })
      .returning()
    backup = b!
  })

  after(async () => {
    await app.close()
    await ctx.db.delete(orgs).where(eq(orgs.id, orgId))
    await ctx.db.delete(users).where(eq(users.id, userId))
    await closeContext(ctx)
    await rm(root, { recursive: true, force: true })
  })

  test('a stopped service can be restored', async () => {
    const row = await requestRestore(ctx, backup, service, { userId })
    assert.equal(row.status, 'pending')
    assert.equal(row.volumeName, 'db-data')
    assert.equal(row.nodeId, nodeId, 'onto the node holding the volume')
  })

  test('the node is handed the job', async () => {
    const jobs = await restoresForNode(ctx, nodeId)
    assert.equal(jobs.length, 1)
    assert.equal(jobs[0]!.volume, 'db-data')
  })

  test('one restore at a time', async () => {
    await assert.rejects(
      () => requestRestore(ctx, backup, service, { userId }),
      (err: unknown) => err instanceof ApiError && /already in progress/.test(err.message)
    )
  })

  test('a running service is refused, and told why', async () => {
    // The whole safety story. Extracting a data directory underneath a process
    // that is using it produces a volume that is neither the old state nor the
    // new one, and the damage surfaces long afterwards as unreadable pages.
    await ctx.db.delete(restores).where(eq(restores.serviceId, service.id))
    await ctx.db.insert(deployments).values({
      serviceId: service.id, nodeId, status: 'running', imageTags: ['postgres:16-alpine'],
    })

    await assert.rejects(
      () => requestRestore(ctx, backup, service, { userId }),
      (err: unknown) => {
        assert.ok(err instanceof ApiError)
        assert.match(err.message, /Stop it first/)
        assert.match(err.message, /corrupts the volume/)
        return true
      }
    )
  })

  test('an incomplete backup cannot be restored', async () => {
    const [pending] = await ctx.db
      .insert(backups)
      .values({ serviceId: service.id, nodeId, volumeRef: 'db-data', status: 'pending' })
      .returning()
    await assert.rejects(
      () => requestRestore(ctx, pending!, service, { userId }),
      (err: unknown) => err instanceof ApiError && /no archive to restore/.test(err.message)
    )
  })
})

describe('scheduled backups', () => {
  test('only the known cadences are accepted', () => {
    assert.equal(intervalFor('daily'), 24 * 60 * 60_000)
    assert.equal(intervalFor('HOURLY'), 60 * 60_000)
    assert.equal(intervalFor('weekly'), 7 * 24 * 60 * 60_000)
    // A cadence Fleet does not implement must not silently mean "never".
    assert.equal(intervalFor('fortnightly'), null)
    assert.equal(intervalFor(''), null)
  })
})

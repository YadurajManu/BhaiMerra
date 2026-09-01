/**
 * fleet backup — take a copy of a service's volume, and list what exists.
 *
 * A volume is the one thing Fleet cannot reproduce. Everything else here is
 * derived: an image rebuilds from a commit, a container recreates from a
 * manifest. The bytes in a database's data directory live on exactly one disk,
 * and until now there was no way to get a copy of them off it.
 */
import { request, requireFleet, CliError, EXIT } from '../api.js'
import { c, table, relativeTime } from '../render.js'
import { glyph, task } from '../ui.js'
import type { Flags } from '../args.js'

type Backup = {
  id: string
  status: 'pending' | 'running' | 'complete' | 'failed'
  volumeRef: string
  sizeBytes: number | null
  checksum: string | null
  failureReason: string | null
  scheduled: boolean
  createdAt: string
  finishedAt: string | null
}

type Service = { id: string; name: string; persistentVolume: boolean; volumeName: string | null }

export function humanBytes(n: number): string {
  if (n < 1024) return `${n} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = n / 1024
  let i = 0
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024
    i++
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[i]}`
}

async function resolveService(fleetId: string, name: string): Promise<Service> {
  const { body } = await request<{ services: Service[] }>('GET', `/fleets/${fleetId}/services`)
  const match = body.services.find((s) => s.name === name || s.id === name)
  if (!match) {
    throw new CliError(
      `No service called "${name}". Known: ${body.services.map((s) => s.name).join(', ') || 'none'}`,
      EXIT.usage
    )
  }
  return match
}

const STATUS_TONE: Record<Backup['status'], (s: string) => string> = {
  complete: c.green,
  running: c.yellow,
  pending: c.dim,
  failed: c.red,
}

export const backupCommand = {
  async run(args: string[], flags: Flags) {
    const [name] = args
    if (!name) throw new CliError('usage: fleet backup <service>', EXIT.usage)

    const fleetId = await requireFleet(typeof flags.fleet === 'string' ? flags.fleet : undefined)
    const service = await resolveService(fleetId, name)

    const created = await task(
      `asking ${c.bold(service.name)}'s node for a copy of its volume`,
      async () =>
        (
          await request<{ backup: Backup }>(
            'POST',
            `/fleets/${fleetId}/services/${service.id}/backups`,
            { body: {} }
          )
        ).body.backup,
      { done: (b) => `queued backup of ${b.volumeRef}` }
    )

    console.log(`\n${glyph.ok} ${c.green('queued')}  ${c.bold(created.id.slice(0, 8))}`)
    console.log(
      c.dim(
        '  The node holding the volume performs it on its next poll — a large volume takes a while.'
      )
    )
    console.log(c.dim(`\n  fleet backups ${service.name}   watch it finish`))
  },
}

export const backupsCommand = {
  async run(args: string[], flags: Flags) {
    const [name] = args
    if (!name) throw new CliError('usage: fleet backups <service>', EXIT.usage)

    const fleetId = await requireFleet(typeof flags.fleet === 'string' ? flags.fleet : undefined)
    const service = await resolveService(fleetId, name)

    const { body } = await request<{ backups: Backup[] }>(
      'GET',
      `/fleets/${fleetId}/services/${service.id}/backups`
    )

    if (flags.json) return console.log(JSON.stringify(body.backups, null, 2))

    if (!body.backups.length) {
      if (!service.persistentVolume) {
        console.log(`"${service.name}" has no volume, so there is nothing to back up.`)
        console.log(
          c.dim('  Its image and manifest already describe everything it holds.')
        )
        return
      }
      console.log(`No backups of ${c.bold(service.name)} yet.`)
      console.log(c.dim(`  take one with \`fleet backup ${service.name}\``))
      return
    }

    console.log(
      table(
        ['when', 'status', 'size', 'source', 'id'],
        body.backups.map((b) => [
          relativeTime(b.createdAt),
          STATUS_TONE[b.status](b.status),
          b.sizeBytes ? humanBytes(b.sizeBytes) : c.dim('—'),
          b.scheduled ? c.dim('scheduled') : c.dim('manual'),
          c.dim(b.id.slice(0, 8)),
        ])
      )
    )

    // Failures are the half people come here for, and a table cell is too
    // narrow to say anything useful about one.
    const failed = body.backups.filter((b) => b.status === 'failed' && b.failureReason)
    for (const b of failed.slice(0, 3)) {
      console.log(
        `\n${glyph.warn} ${c.yellow(b.id.slice(0, 8))}  ${b.failureReason!.split('\n')[0]!.slice(0, 160)}`
      )
    }

    const complete = body.backups.filter((b) => b.status === 'complete')
    if (complete.length) {
      const total = complete.reduce((sum, b) => sum + (b.sizeBytes ?? 0), 0)
      console.log(c.dim(`\n  ${complete.length} complete, ${humanBytes(total)} stored.`))
    }
  },
}

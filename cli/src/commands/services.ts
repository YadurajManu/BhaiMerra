import { readFile, writeFile, access } from 'node:fs/promises'
import { join } from 'node:path'
import { request, requireFleet, CliError, EXIT } from '../api.js'
import { c, table, statusColour, keyValues, relativeTime, mb } from '../render.js'
import type { Flags } from '../args.js'

type Service = {
  id: string
  name: string
  placementPolicy: string
  requestRamMb: number
  persistentVolume: boolean
  hostname: string | null
  domain: string | null
  current: { nodeName: string | null; status: string; gitSha: string | null } | null
}

const manifestPath = (given?: string) => given ?? 'fleet.yaml'

async function readManifest(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8')
  } catch {
    throw new CliError(`No ${path} here. Run \`fleet init\` to scaffold one.`, EXIT.usage)
  }
}

export const validateCommand = {
  async run(args: string[], flags: Flags) {
    const fleetId = await requireFleet(typeof flags.fleet === 'string' ? flags.fleet : undefined)
    const manifest = await readManifest(manifestPath(args[0]))

    const { body } = await request<{
      valid: boolean
      services?: Array<{ name: string; placement: string; ramMb: number }>
      warnings?: string[]
      issues?: Array<{ path: string; message: string }>
    }>('POST', `/fleets/${fleetId}/services/validate`, { body: { manifest } })

    if (flags.json) return console.log(JSON.stringify(body, null, 2))

    if (!body.valid) {
      console.error(c.red(`${body.issues!.length} problem(s) in ${manifestPath(args[0])}:\n`))
      for (const issue of body.issues!) console.error(`  ${c.bold(issue.path)}\n    ${issue.message}`)
      process.exit(EXIT.usage)
    }

    console.log(c.green('valid') + `  ${body.services!.length} service(s)`)
    console.log(
      table(
        ['service', 'placement', 'ram'],
        body.services!.map((s) => [s.name, s.placement, mb(s.ramMb)])
      )
    )
    for (const w of body.warnings ?? []) console.log(`\n${c.yellow('warning')}  ${w}`)
  },
}

export const applyCommand = {
  async run(args: string[], flags: Flags) {
    const fleetId = await requireFleet(typeof flags.fleet === 'string' ? flags.fleet : undefined)
    const manifest = await readManifest(manifestPath(args[0]))

    const { body } = await request<{
      created: string[]
      updated: string[]
      orphaned: string[]
      warnings: string[]
    }>('POST', `/fleets/${fleetId}/services`, { body: { manifest } })

    if (flags.json) return console.log(JSON.stringify(body, null, 2))

    if (body.created.length) console.log(`${c.green('created')}  ${body.created.join(', ')}`)
    if (body.updated.length) console.log(`${c.cyan('updated')}  ${body.updated.join(', ')}`)
    if (!body.created.length && !body.updated.length) console.log('no changes')
    for (const w of body.warnings) console.log(`\n${c.yellow('warning')}  ${w}`)
  },
}

export const servicesCommand = {
  async run(_args: string[], flags: Flags) {
    const fleetId = await requireFleet(typeof flags.fleet === 'string' ? flags.fleet : undefined)
    const { body } = await request<{ services: Service[] }>('GET', `/fleets/${fleetId}/services`)

    if (flags.json) return console.log(JSON.stringify(body.services, null, 2))
    if (!body.services.length) return console.log('No services. Run `fleet apply` with a fleet.yaml.')

    console.log(
      table(
        ['service', 'url', 'placement', 'node', 'sha', 'status'],
        body.services.map((s) => [
          s.name + (s.persistentVolume ? c.dim(' ⛁') : ''),
          s.domain ?? s.hostname ?? c.dim('—'),
          s.placementPolicy,
          s.current?.nodeName ?? c.dim('—'),
          s.current?.gitSha?.slice(0, 7) ?? c.dim('—'),
          s.current ? statusColour(s.current.status) : c.dim('not deployed'),
        ])
      )
    )
  },
}

async function findService(fleetId: string, name: string): Promise<Service> {
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

export const deployCommand = {
  async run(args: string[], flags: Flags) {
    const fleetId = await requireFleet(typeof flags.fleet === 'string' ? flags.fleet : undefined)
    const [name] = args
    if (!name) throw new CliError('usage: fleet deploy <service> [--sha <git-sha>]', EXIT.usage)

    const service = await findService(fleetId, name)
    const gitSha = typeof flags.sha === 'string' ? flags.sha : undefined

    console.log(`deploying ${c.bold(service.name)}${gitSha ? ` at ${gitSha.slice(0, 7)}` : ''}…`)
    const { body } = await request<{
      placedOn: { name: string }
      score: number
      url: string | null
      warnings: string[]
    }>('POST', `/services/${service.id}/deploy`, { body: { gitSha } })

    if (flags.json) return console.log(JSON.stringify(body, null, 2))
    console.log(`${c.green('scheduled')} onto ${c.bold(body.placedOn.name)} ${c.dim(`score ${body.score?.toFixed(3)}`)}`)
    if (body.url) console.log(`${c.green('live')}      ${c.cyan(body.url)}`)
    for (const w of body.warnings ?? []) console.log(`${c.yellow('warning')}  ${w}`)
  },
}

export const whereCommand = {
  async run(args: string[], flags: Flags) {
    const fleetId = await requireFleet(typeof flags.fleet === 'string' ? flags.fleet : undefined)
    const [name] = args
    if (!name) throw new CliError('usage: fleet where <service>', EXIT.usage)

    const service = await findService(fleetId, name)
    const { body } = await request<{ decision: any }>('GET', `/services/${service.id}/placement-preview`)
    const d = body.decision

    if (flags.json) return console.log(JSON.stringify(d, null, 2))

    if (d.outcome !== 'placed') {
      console.log(c.red('no eligible node'))
      console.log(`  ${d.summary}\n`)
      console.log(
        table(
          ['node', 'why not'],
          d.rejected.map((r: any) => [r.nodeName, `${c.dim(r.code)}  ${r.detail}`])
        )
      )
      process.exit(EXIT.noEligibleNode)
    }

    console.log(`${c.green('would place on')} ${c.bold(d.nodeName)}\n`)
    console.log(
      table(
        ['node', 'score', 'headroom', 'reliability', 'load', 'free'],
        d.candidates.map((cand: any) => [
          cand.nodeName,
          cand.score.toFixed(4),
          cand.breakdown.headroom.toFixed(3),
          cand.breakdown.reliability.toFixed(2),
          cand.breakdown.load.toFixed(2),
          mb(cand.freeRamMb),
        ])
      )
    )
    if (d.rejected.length) {
      console.log(`\n${c.dim('not eligible:')}`)
      for (const r of d.rejected) console.log(`  ${r.nodeName}  ${c.dim(r.code)}  ${r.detail}`)
    }
  },
}

export const rescheduleCommand = {
  async run(args: string[], flags: Flags) {
    const fleetId = await requireFleet(typeof flags.fleet === 'string' ? flags.fleet : undefined)
    const [name] = args
    if (!name) throw new CliError('usage: fleet reschedule <service>', EXIT.usage)

    const service = await findService(fleetId, name)
    const { body } = await request<{ movedTo: { name: string }; score: number }>(
      'POST',
      `/services/${service.id}/reschedule`
    )
    console.log(`${c.green('moved')} ${service.name} → ${c.bold(body.movedTo.name)}`)
  },
}

export const deploymentsCommand = {
  async run(args: string[], flags: Flags) {
    const fleetId = await requireFleet(typeof flags.fleet === 'string' ? flags.fleet : undefined)
    const [name] = args
    if (!name) throw new CliError('usage: fleet deployments <service>', EXIT.usage)

    const service = await findService(fleetId, name)
    const { body } = await request<{
      deployments: Array<{
        id: string
        gitSha: string | null
        status: string
        nodeName: string | null
        startedAt: string
        failureReason: string | null
      }>
    }>('GET', `/services/${service.id}/deployments`)

    if (flags.json) return console.log(JSON.stringify(body.deployments, null, 2))
    console.log(
      table(
        ['when', 'sha', 'node', 'status', 'note'],
        body.deployments.map((d) => [
          relativeTime(d.startedAt),
          d.gitSha?.slice(0, 7) ?? c.dim('—'),
          d.nodeName ?? c.dim('—'),
          statusColour(d.status),
          d.failureReason ?? '',
        ])
      )
    )
  },
}

const TEMPLATE = (name: string, hasDockerfile: boolean) => `fleet: homelab

services:
  ${name}:
    ${hasDockerfile ? 'build: .' : 'image: nginx:1.27   # or build: . once you add a Dockerfile'}
    placement: flexible
    resources: { ram: 512Mi, cpu: 0.5 }
    health: { path: /healthz }
    # domain: ${name}.yourdomain.dev
`

export const initCommand = {
  async run(args: string[], flags: Flags) {
    const path = manifestPath(args[0])
    try {
      await access(path)
      throw new CliError(`${path} already exists — not overwriting it.`, EXIT.usage)
    } catch (err) {
      if (err instanceof CliError) throw err
    }

    // Infer the service name from the directory, which is right often enough
    // to be useful and obvious enough to correct when it is not.
    const name =
      (typeof flags.name === 'string' ? flags.name : '') ||
      process.cwd().split('/').pop()?.toLowerCase().replace(/[^a-z0-9-]+/g, '-') ||
      'app'

    let hasDockerfile = true
    try {
      await access(join(process.cwd(), 'Dockerfile'))
    } catch {
      hasDockerfile = false
    }

    await writeFile(path, TEMPLATE(name, hasDockerfile))
    console.log(`${c.green('created')} ${path}`)
    if (!hasDockerfile) {
      console.log(c.dim('  no Dockerfile found, so it starts from a prebuilt image'))
    }
    console.log(`\nNext:\n  fleet validate\n  fleet apply\n  fleet deploy ${name}`)
  },
}

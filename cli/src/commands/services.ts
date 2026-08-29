import { readFile, writeFile, access } from 'node:fs/promises'
import { join } from 'node:path'
import { request, requireFleet, CliError, EXIT } from '../api.js'
import { c, table, statusColour, keyValues, relativeTime, mb } from '../render.js'
import { task, glyph } from '../ui.js'
import { withLadder } from '../ladder.js'
import { ask, canPrompt, confirm, selectOrThrow } from '../prompt.js'
import {
  DEPLOY_STEPS,
  follow,
  phaseWalker,
} from '../progress.js'
import type { Flags } from '../args.js'

type Service = {
  id: string
  name: string
  repoUrl: string | null
  placementPolicy: string
  requestRamMb: number
  persistentVolume: boolean
  hostname: string | null
  domain: string | null
  current: { nodeName: string | null; status: string; gitSha: string | null } | null
}

type PlacementPreview = {
  outcome: 'placed' | 'no_eligible_node'
  nodeName?: string
  candidates: Array<{ nodeName: string; score: number; breakdown: { headroom: number; reliability: number; load: number } }>
  rejected: Array<{ nodeName: string; code: string; detail: string }>
  summary?: string
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

    const body = await task(`checking ${manifestPath(args[0])}`, async () =>
      (
        await request<{
          valid: boolean
          services?: Array<{ name: string; placement: string; ramMb: number }>
          warnings?: string[]
          issues?: Array<{ path: string; message: string }>
        }>('POST', `/fleets/${fleetId}/services/validate`, { body: { manifest } })
      ).body
    )

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

    const body = await task(
      `applying ${manifestPath(args[0])}`,
      async () =>
        (
          await request<{
            created: string[]
            updated: string[]
            orphaned: string[]
            warnings: string[]
          }>('POST', `/fleets/${fleetId}/services`, { body: { manifest } })
        ).body,
      {
        done: (b) =>
          b.created.length || b.updated.length
            ? `applied ${b.created.length + b.updated.length} service(s)`
            : 'no changes',
      }
    )

    if (flags.json) return console.log(JSON.stringify(body, null, 2))

    if (body.created.length) console.log(`${glyph.ok} ${c.green('created')}  ${body.created.join(', ')}`)
    if (body.updated.length) console.log(`${glyph.ok} ${c.cyan('updated')}  ${body.updated.join(', ')}`)
    for (const w of body.warnings) console.log(`${glyph.warn} ${c.yellow('warning')}  ${w}`)
    if (body.created.length) console.log(c.dim(`\nnext: fleet deploy ${body.created[0]}`))
  },
}

export const servicesCommand = {
  async run(args: string[], flags: Flags) {
    // `fleet services rm <name>` is the same action as `fleet rm <name>`;
    // both spellings exist because one reads as a subcommand of the noun and
    // the other as the short form an operator reaches for under pressure.
    if (args[0] === 'rm' || args[0] === 'remove' || args[0] === 'delete') {
      return removeServiceCommand.run(args.slice(1), flags)
    }

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

async function deployPlan(fleetId: string, service: Service): Promise<PlacementPreview> {
  return (await request<{ decision: PlacementPreview }>('GET', `/services/${service.id}/placement-preview`)).body.decision
}

function printPlan(service: Service, plan: PlacementPreview, gitSha?: string) {
  console.log(`\n${c.bold(`Plan for ${service.name}`)}`)
  if (plan.outcome !== 'placed' || !plan.nodeName) {
    console.log(`${c.red('  placement')}    ${plan.summary ?? 'No eligible node'}`)
    for (const rejected of plan.rejected) console.log(`  ${c.dim(rejected.nodeName.padEnd(12))} ${rejected.detail}`)
    return false
  }
  const winner = plan.candidates[0]
  const source = service.repoUrl
    ? `${service.repoUrl}${gitSha ? ` · ${gitSha.slice(0, 12)}` : ''}`
    : gitSha ? gitSha.slice(0, 12) : 'service definition'
  const target = plan.nodeName
  const reason = winner
    ? `highest eligible score (${winner.score.toFixed(3)}; headroom ${winner.breakdown.headroom.toFixed(2)}, load ${winner.breakdown.load.toFixed(2)})`
    : 'eligible for this service'
  const url = service.domain ?? service.hostname ?? 'assigned after scheduling'
  console.log(`  ${c.dim('source'.padEnd(12))} ${source}`)
  console.log(`  ${c.dim('target'.padEnd(12))} ${c.signal(target)}`)
  console.log(`  ${c.dim('reason'.padEnd(12))} ${reason}`)
  console.log(`  ${c.dim('URL'.padEnd(12))} ${url.startsWith('http') ? url : `https://${url}`}`)
  return true
}

async function confirmDeploy(): Promise<boolean> {
  if (!process.stdin.isTTY) return true
  const { createInterface } = await import('node:readline/promises')
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    return (await rl.question('  Continue? [y/N] ')).trim().toLowerCase() === 'y'
  } finally {
    rl.close()
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * The deploy request returns once the image exists and a node has been chosen.
 * The container starting is the agent's job and happens afterwards, so the CLI
 * follows it to conclusion rather than reporting "scheduled" and leaving the
 * operator to guess.
 */
async function waitUntilRunning(fleetId: string, name: string, timeoutMs = 180_000) {
  await task(
    `waiting for ${c.bold(name)} to come up`,
    async (s) => {
      s.hints([
        'the agent picks up desired state on its next poll',
        'a cold image pull takes as long as the node\'s uplink does',
        'this clears once the agent reports the container running',
      ])
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        const current = await findService(fleetId, name)
          .then((svc) => svc.current)
          .catch(() => null)

        if (current?.status === 'running') return
        if (current?.status === 'failed') {
          throw new CliError(
            `"${name}" did not start. \`fleet deployments ${name}\` has the reason.`,
            EXIT.healthCheckFailed
          )
        }
        await sleep(2000)
      }
      throw new CliError(
        `"${name}" was scheduled but has not reported running. \`fleet deployments ${name}\` has the detail.`,
        EXIT.healthCheckFailed
      )
    },
    { done: () => `${c.bold(name)} is running` }
  )
}

export const deployCommand = {
  async run(args: string[], flags: Flags) {
    const fleetId = await requireFleet(typeof flags.fleet === 'string' ? flags.fleet : undefined)
    const [name] = args
    if (!name) throw new CliError('usage: fleet deploy <service> [--sha <git-sha>] [--no-wait]', EXIT.usage)

    const service = await findService(fleetId, name)
    const gitSha = typeof flags.sha === 'string' ? flags.sha : undefined

    const plan = await task('checking deployment plan', async () => deployPlan(fleetId, service))
    const viable = plan.outcome === 'placed' && Boolean(plan.nodeName)
    if (!flags.json) printPlan(service, plan, gitSha)
    if (flags.json && (flags.plan || flags['dry-run'])) {
      console.log(JSON.stringify({ service: service.name, gitSha: gitSha ?? null, plan }, null, 2))
      return
    }
    if (!viable) {
      if (flags.json) console.log(JSON.stringify({ service: service.name, gitSha: gitSha ?? null, plan }, null, 2))
      process.exitCode = EXIT.noEligibleNode
      return
    }
    if (flags.plan || flags['dry-run']) return
    if (!flags.yes && !flags.y && !(await confirmDeploy())) {
      console.log(c.dim('Deployment cancelled. Re-run with --yes to skip confirmation.'))
      return
    }

    const body = await withLadder(
      DEPLOY_STEPS,
      async (ladder) => {
        const walker = phaseWalker(ladder)
        const progress = follow(service.id, (p) => walker.apply(p), {
          onUnavailable: () => ladder.note(c.dim('live progress unavailable; continuing with the deploy request')),
        })
        try {
          const result = (
            await request<{
              placedOn: { name: string }
              score: number
              url: string | null
              warnings: string[]
            }>('POST', `/services/${service.id}/deploy`, { body: { gitSha } })
          ).body
          walker.finish(`scheduled onto ${result.placedOn.name}`)
          return result
        } finally {
          await progress.stop()
        }
      },
      {
        mark: true,
        title: `deploying ${service.name}${gitSha ? ` at ${gitSha.slice(0, 7)}` : ''}`,
        onCancel: `deploy is still running on the control plane; inspect with fleet deployments ${service.name}`,
      }
    )

    if (flags.json) return console.log(JSON.stringify(body, null, 2))

    for (const w of body.warnings ?? []) console.log(`${glyph.warn} ${c.yellow('warning')}  ${w}`)
    if (body.url) console.log(`${glyph.info} ${c.cyan(body.url)}`)

    if (!flags['no-wait']) await waitUntilRunning(fleetId, service.name)
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

export const restartCommand = {
  async run(args: string[], flags: Flags) {
    const fleetId = await requireFleet(typeof flags.fleet === 'string' ? flags.fleet : undefined)
    const [name] = args
    if (!name) throw new CliError('usage: fleet restart <service>', EXIT.usage)
    const service = await findService(fleetId, name)
    const { body } = await request<{ deployment: { id: string } }>('POST', `/services/${service.id}/restart`, { body: {} })
    if (flags.json) return console.log(JSON.stringify(body, null, 2))
    console.log(`${glyph.ok} ${c.green('restart scheduled')}  ${service.name} ${c.dim(body.deployment.id.slice(0, 8))}`)
    if (!flags['no-wait']) await waitUntilRunning(fleetId, service.name)
  },
}

export const rollbackCommand = {
  async run(args: string[], flags: Flags) {
    const fleetId = await requireFleet(typeof flags.fleet === 'string' ? flags.fleet : undefined)
    const [name, deploymentId] = args
    if (!name) throw new CliError('usage: fleet rollback <service> [deployment-id]', EXIT.usage)
    const service = await findService(fleetId, name)
    if (!flags.yes && !flags.y && !(await confirmDeploy())) { console.log(c.dim('Rollback cancelled.')); return }
    const { body } = await request<{ rolledBackTo: string }>('POST', `/services/${service.id}/rollback`, { body: deploymentId ? { deploymentId } : {} })
    if (flags.json) return console.log(JSON.stringify(body, null, 2))
    console.log(`${glyph.ok} ${c.green('rollback scheduled')}  ${service.name} ← ${c.dim(body.rolledBackTo.slice(0, 8))}`)
    if (!flags['no-wait']) await waitUntilRunning(fleetId, service.name)
  },
}

export const logsCommand = {
  async run(args: string[], flags: Flags) {
    const fleetId = await requireFleet(typeof flags.fleet === 'string' ? flags.fleet : undefined)
    const [name] = args
    if (!name) throw new CliError('usage: fleet logs <service> [--follow] [--since 1h]', EXIT.usage)
    const service = await findService(fleetId, name)
    if (flags.since) console.error(c.dim('note: agent log tails are live snapshots; --since is limited to the current retained tail.'))
    let previous = ''
    const render = async () => {
      const { body } = await request<{ lines: string[]; node: { name: string }; diagnostic: string | null }>('GET', `/services/${service.id}/logs`)
      const next = body.lines.join('\n')
      if (!next) { if (body.diagnostic) console.log(c.yellow(`waiting: ${body.diagnostic}`)); return }
      const output = next.startsWith(previous) ? next.slice(previous.length) : next
      if (output) process.stdout.write(output + (output.endsWith('\n') ? '' : '\n'))
      previous = next
    }
    await render()
    if (!flags.follow && !flags.f) return
    if (!process.stdout.isTTY) throw new CliError('--follow needs an interactive terminal', EXIT.usage)
    while (true) { await sleep(2000); await render() }
  },
}

export const initCommand = {
  async run(args: string[], flags: Flags) {
    const { detect, manifestTemplate } = await import('../detect.js')

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

    const d = await detect()

    // Write a Dockerfile if we generated one and none exists.
    if (d.dockerfile) {
      await writeFile(join(process.cwd(), 'Dockerfile'), d.dockerfile)
      console.log(`${c.green('created')} Dockerfile  ${c.dim(`(${d.label}, port ${d.port})`)}`)
    }

    await writeFile(path, manifestTemplate(name, d))
    console.log(`${c.green('created')} ${path}`)

    if (d.framework === 'unknown' && !d.hasDockerfile) {
      console.log(c.dim('  could not detect framework — using defaults. Edit fleet.yaml to tune.'))
    } else if (d.hasDockerfile) {
      console.log(c.dim(`  using existing Dockerfile (detected EXPOSE ${d.port})`))
    } else {
      console.log(c.dim(`  detected ${c.bold(d.label)} → optimised Dockerfile + manifest`))
    }

    console.log(`\nNext:\n  fleet validate\n  fleet apply\n  fleet deploy ${name}`)
    console.log(c.dim(`\n  …or just run: fleet up`))
  },
}

/**
 * fleet rm <service> / fleet services rm <service> — permanently undeploy.
 *
 * Distinct from `fleet down`, which stops the workload but keeps the service
 * definition so it can be redeployed. This removes the definition too, which
 * is not recoverable from the control plane, so the confirmation is required
 * rather than best-effort: a non-interactive caller must pass --yes explicitly
 * instead of having silence taken as consent.
 */
export const removeServiceCommand = {
  async run(args: string[], flags: Flags) {
    // Before requireFleet, which reaches the control plane when no fleet is
    // saved: a missing argument is a usage error and should not depend on the
    // network being up to say so.
    const [name] = args
    if (!name) throw new CliError('usage: fleet rm <service> [--yes]', EXIT.usage)

    const fleetId = await requireFleet(typeof flags.fleet === 'string' ? flags.fleet : undefined)
    const service = await findService(fleetId, name)
    const confirmed = flags.yes === true || flags.y === true

    if (!confirmed) {
      if (!process.stdin.isTTY) {
        throw new CliError(
          `Deleting "${service.name}" is permanent. Re-run with --yes to confirm.`,
          EXIT.usage
        )
      }
      const { createInterface } = await import('node:readline/promises')
      const rl = createInterface({ input: process.stdin, output: process.stdout })
      try {
        console.log(
          `\n  This permanently deletes ${c.bold(service.name)} from the fleet:` +
            `\n    ${c.dim('·')} its containers are removed from the node it runs on` +
            `\n    ${c.dim('·')} its deployment history and URL are released` +
            `\n  ${c.dim('To stop it without deleting it, use `fleet down` instead.')}\n`
        )
        const ans = await rl.question(`  Type the service name to confirm [${c.dim(service.name)}]: `)
        if (ans.trim() !== service.name) {
          console.log(c.dim('Delete cancelled.'))
          return
        }
      } finally {
        rl.close()
      }
    }

    const { body } = await request<{ deleted: boolean; service: string; stopped: number; note?: string }>(
      'DELETE',
      `/services/${service.id}`
    )

    if (flags.json) return console.log(JSON.stringify(body, null, 2))

    console.log(`${glyph.ok} ${c.red('deleted')}  ${c.bold(body.service)}`)
    if (body.note) console.log(c.dim(`  ${body.note}`))
  },
}

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
import { planFromManifest, projectNameFor } from '../plan.js'
import { uploadContext, humanBytes } from '../archive.js'
import type { Flags } from '../args.js'

type Service = {
  id: string
  name: string
  project: string
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

    // --dry-run used to be accepted and ignored, so `fleet apply --dry-run`
    // applied. `fleet init` prints that exact command as the safe way to check
    // its output, which made the one command the tool recommends for looking
    // before you leap the command that leapt. The control plane has always had
    // an endpoint for this, labelled "validate without touching anything"; the
    // CLI simply never called it.
    if (flags['dry-run'] || flags.plan) {
      const { body } = await request<{
        valid: boolean
        fleet?: string
        services?: Array<{ name: string; placement: string; ramMb: number; arch: string[] }>
        warnings?: string[]
        issues?: string[]
      }>('POST', `/fleets/${fleetId}/services/validate`, { body: { manifest } })

      if (flags.json) return console.log(JSON.stringify(body, null, 2))

      if (!body.valid) {
        for (const issue of body.issues ?? []) {
          console.log(`${glyph.fail} ${c.red('invalid')}  ${issue}`)
        }
        throw new CliError('The manifest was not applied.', EXIT.usage)
      }

      console.log(`${glyph.ok} ${c.green('valid')}  fleet ${c.bold(body.fleet ?? '?')}`)
      for (const svc of body.services ?? []) {
        // arch is empty when the manifest does not constrain it, which is the
        // common case; printing a trailing separator for nothing reads like a
        // value failed to load.
        const facts = [svc.placement, `${svc.ramMb}Mi`, svc.arch?.join(', ')].filter(Boolean)
        console.log(`  ${c.bold(svc.name)}  ${c.dim(facts.join(' · '))}`)
      }
      for (const w of body.warnings ?? []) {
        console.log(`${glyph.warn} ${c.yellow('warning')}  ${w}`)
      }
      return console.log(c.dim('\nnothing was changed. Drop --dry-run to apply.'))
    }

    const body = await task(
      `applying ${manifestPath(args[0])}`,
      async () =>
        (
          await request<{
            project: string
            created: string[]
            updated: string[]
            orphaned: string[]
            warnings: string[]
          }>('POST', `/fleets/${fleetId}/services`, {
            body: { manifest, project: projectNameFor(process.cwd()) },
          })
        ).body,
      {
        done: (b) =>
          b.created.length || b.updated.length
            ? `applied ${b.created.length + b.updated.length} service(s) to project ${b.project}`
            : `no changes in project ${b.project}`,
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

    // Grouped by project. A fleet.yaml describes a stack, and listing its
    // services flat among somebody else's is how four related things came to
    // look like four unrelated ones.
    const byProject = new Map<string, Service[]>()
    for (const s of body.services) {
      const key = s.project || 'default'
      const group = byProject.get(key) ?? []
      group.push(s)
      byProject.set(key, group)
    }

    for (const [project, group] of [...byProject].sort((a, b) => a[0].localeCompare(b[0]))) {
      const running = group.filter((s) => s.current?.status === 'running').length
      const ram = group.reduce((sum, s) => sum + s.requestRamMb, 0)
      console.log(
        `\n${c.bold(project)}  ${c.dim(`${running}/${group.length} running · ${mb(ram)}`)}`
      )
      console.log(
        table(
          ['service', 'url', 'placement', 'node', 'sha', 'status'],
          group.map((s) => [
            s.name + (s.persistentVolume ? c.dim(' ⛁') : ''),
            s.domain ?? s.hostname ?? c.dim('—'),
            s.placementPolicy,
            s.current?.nodeName ?? c.dim('—'),
            s.current?.gitSha?.slice(0, 7) ?? c.dim('—'),
            s.current ? statusColour(s.current.status) : c.dim('not deployed'),
          ])
        )
      )
    }
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

/**
 * The build context a service declares, if any, read from the local manifest.
 *
 * Absent when there is no fleet.yaml here — deploying from outside the
 * repository is legitimate for a prebuilt `image:` service, and should not
 * become an error about a file the operator never needed.
 */
async function buildContextFor(serviceName: string): Promise<string | undefined> {
  try {
    const source = await readFile('fleet.yaml', 'utf8')
    return planFromManifest(source).find((s) => s.name === serviceName)?.build
  } catch {
    return undefined
  }
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

    // A service that builds from source needs its directory sent, or the
    // control plane has nothing to build and says the context does not exist.
    // Read from the manifest here rather than from the service row, because
    // the build path is relative to the file the operator is standing in.
    let contextId: string | undefined
    const buildContext = await buildContextFor(service.name)
    if (buildContext) {
      const uploaded = await task(
        `packaging ${c.bold(service.name)}`,
        async () => uploadContext(service.id, join(process.cwd(), buildContext)),
        { done: (r) => `uploaded ${humanBytes(r.bytes)} of build context` }
      )
      contextId = uploaded.contextId
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
            }>('POST', `/services/${service.id}/deploy`, { body: { gitSha, contextId } })
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

/**
 * The node to pin a database to, when there is only one it could be.
 *
 * A database has to name the node holding its data — that is the one decision
 * Fleet will not make for you, because moving a database moves its disk. But
 * on a fleet with a single node there is no decision to make, and writing
 * CHANGE_ME there meant `init` produced a manifest whose next command fails:
 *
 *     error  The manifest names nodes that are not in this fleet
 *       services.db.node: no node named "CHANGE_ME" in this fleet
 *
 * Best effort, and quiet about it. `init` otherwise needs no control plane at
 * all — it reads a directory — so a missing session, an unreachable server or
 * a fleet with several nodes all fall back to the placeholder rather than
 * turning a local command into one that requires the network.
 */
async function theOnlyNode(flags: Flags): Promise<string | undefined> {
  try {
    const fleetId = await requireFleet(typeof flags.fleet === 'string' ? flags.fleet : undefined)
    const { body } = await request<{ nodes: Array<{ name: string; status: string }> }>(
      'GET',
      `/fleets/${fleetId}/nodes`
    )
    // Offline is fine: a node that is down still holds its disk, and that is
    // what pinning is about. Only an empty fleet has nothing to choose.
    if (body.nodes.length !== 1) return undefined
    const only = body.nodes[0]!.name
    console.log(c.dim(`  · pinned the database to ${only}, the only node in this fleet`))
    return only
  } catch {
    return undefined
  }
}

/**
 * A second opinion on the draft, when --ai is given.
 *
 * Opt-in, because it sends a description of the repository to whatever
 * provider the control plane is configured with, and that should never be a
 * surprise. Never fatal: the draft is what `init` produced without it, so any
 * failure here leaves the user exactly where they would have been anyway.
 *
 * The changes are printed rather than applied silently. A manifest that
 * appeared with different ports and no explanation is worse than one with a
 * mistake in it -- at least the mistake is yours to find.
 */
async function reviewed(draft: string, flags: Flags): Promise<string> {
  const { repoMap } = await import('../repomap.js')
  const fleetId = await requireFleet(typeof flags.fleet === 'string' ? flags.fleet : undefined)

  type Assist =
    | { status: 'ok'; manifest: string; notes: string[]; changed: boolean; model: string; usage: { used: number; limit: number } }
    | { status: 'disabled'; reason: string }
    | { status: 'rate_limited'; limit: number; resetsInSec: number }
    | { status: 'kept_draft'; reason: string }

  let out: Assist
  try {
    const map = await repoMap()
    out = (
      await task(
        'reading the repository for a second opinion',
        async () =>
          request<Assist>('POST', `/fleets/${fleetId}/manifest/assist`, {
            body: { draft, repoMap: map },
          }),
        { done: () => 'reviewed' }
      )
    ).body
  } catch (err) {
    console.log(
      `${glyph.warn} ${c.yellow('review skipped')}  ${err instanceof Error ? err.message : 'the control plane could not be reached'}`
    )
    return draft
  }

  if (out.status === 'disabled') {
    console.log(`${glyph.warn} ${c.yellow('review skipped')}  ${out.reason}`)
    return draft
  }
  if (out.status === 'rate_limited') {
    console.log(
      `${glyph.warn} ${c.yellow('review skipped')}  ${out.limit} reviews a day is the limit; it resets in ${Math.ceil(out.resetsInSec / 3600)}h.`
    )
    return draft
  }
  if (out.status === 'kept_draft') {
    // Worth saying out loud: silence here would read as "the review agreed".
    console.log(`${glyph.warn} ${c.yellow('kept the draft')}  ${out.reason}`)
    return draft
  }
  if (!out.changed) {
    console.log(`${glyph.ok} ${c.green('reviewed')}  ${c.dim('nothing to change')}`)
    return out.manifest
  }

  console.log(`${glyph.ok} ${c.green('reviewed')}  ${c.dim(out.model)}`)
  for (const note of out.notes) console.log(c.dim(`  · ${note}`))
  console.log(c.dim(`  ${out.usage.used}/${out.usage.limit} reviews used today`))
  return out.manifest
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

    // Read the whole repository first. A monorepo, an apps/ directory, or a
    // service beside a database is the ordinary case, and describing only the
    // current directory left every one of those to be written out by hand.
    const { discover, manifestFromDiscovery } = await import('../discover.js')
    const found = await discover()

    if (found.services.length > 1 || found.databases.length) {
      const drafted = manifestFromDiscovery(found, {
        fleet: typeof flags.fleet === 'string' ? flags.fleet : undefined,
        node:
          (typeof flags.node === 'string' ? flags.node : undefined) ??
          (found.databases.length ? await theOnlyNode(flags) : undefined),
      })
      const questions = drafted.questions
      const manifest = flags.ai ? await reviewed(drafted.manifest, flags) : drafted.manifest
      await writeFile(path, manifest)
      console.log(`${c.green('created')} ${path}`)
      if (found.layout) console.log(c.dim(`  ${found.layout}`))

      for (const s of found.services) {
        // A manifest saying `build: ./web` against a directory with no
        // Dockerfile is a deploy that fails at the first step. detect() has
        // already worked out what the file should contain; writing it is the
        // difference between a manifest and something that runs.
        if (s.detection.dockerfile && !s.detection.hasDockerfile) {
          const target = join(process.cwd(), s.dir, 'Dockerfile')
          await writeFile(target, s.detection.dockerfile)
          console.log(
            `${c.green('created')} ${s.dir}/Dockerfile  ${c.dim(`(${s.detection.label}, port ${s.detection.port})`)}`
          )
        }
        console.log(c.dim(`  · ${s.name}  ${s.dir}  ${s.detection.label}`))
      }
      for (const db of found.databases) {
        console.log(c.dim(`  · ${db.name} (${db.engine}) — ${db.because}`))
      }
      for (const q of questions) console.log(`  ${c.yellow('?')} ${q}`)
      console.log(c.dim(`\n  check it with: fleet apply --dry-run`))
      return
    }

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

/**
 * docker-compose.yml → fleet.yaml.
 *
 * The most common way to arrive at Fleet with several services, two languages
 * and a database is to already have a compose file describing exactly that.
 * Reading it is a transform rather than a guess, so this needs no network, no
 * account, and no model — it works before you have signed in.
 *
 * It prints what it decided and what it could not answer. A converter that
 * silently drops a bind mount or invents a node is worse than one that refuses,
 * because the reader only finds out at deploy time.
 */
export const importCommand = {
  async run(args: string[], flags: Flags) {
    const { composeToFleet } = await import('../compose.js')

    const source = args[0] ?? 'docker-compose.yml'
    let text: string
    try {
      text = await readFile(source, 'utf8')
    } catch {
      throw new CliError(
        `could not read ${source}\n  pass a path: fleet import path/to/docker-compose.yml`,
        EXIT.usage
      )
    }

    const out = manifestPath(typeof flags.out === 'string' ? flags.out : undefined)
    const force = flags.force === true
    if (!force) {
      try {
        await access(out)
        throw new CliError(`${out} already exists — pass --force to overwrite it.`, EXIT.usage)
      } catch (err) {
        if (err instanceof CliError) throw err
      }
    }

    let result: { manifest: string; notes: string[]; questions: string[] }
    try {
      result = composeToFleet(text, {
        fleet: typeof flags.fleet === 'string' ? flags.fleet : undefined,
        node: typeof flags.node === 'string' ? flags.node : undefined,
      })
    } catch (err) {
      throw new CliError((err as Error).message, EXIT.usage)
    }

    // --dry-run prints and writes nothing, so the output can be piped or read
    // before it lands next to the file it was derived from.
    if (flags['dry-run'] === true) {
      process.stdout.write(result.manifest)
    } else {
      await writeFile(out, result.manifest)
      console.log(`${c.green('created')} ${out}  ${c.dim(`from ${source}`)}`)
    }

    for (const note of result.notes) console.log(`  ${c.dim('·')} ${c.dim(note)}`)
    for (const q of result.questions) console.log(`  ${c.yellow('?')} ${q}`)

    if (!result.questions.length) {
      console.log(c.dim(`\n  check it with: fleet apply --dry-run`))
    }
  },
}

/**
 * Ask why a deployment failed.
 *
 * The wall of Docker output is still there underneath — this adds a reading of
 * it, it does not replace the evidence. Printed at the moment of failure is the
 * point; `fleet explain` exists for when you have come back to it later.
 */
export const explainCommand = {
  async run(args: string[], flags: Flags) {
    const id = await requireFleet(typeof flags.fleet === 'string' ? flags.fleet : undefined)

    let deploymentId = typeof flags.deploy === 'string' ? flags.deploy : ''
    if (!deploymentId) {
      const name = args[0]
      if (!name) throw new CliError('name a service, or pass --deploy <id>', EXIT.usage)
      const service = await findService(id, name)
      const { body } = await request<{ deployments: Array<{ id: string; status: string }> }>(
        'GET',
        `/services/${service.id}/deployments`
      )
      // The most recent failure, which is what someone asking "why did that
      // fail" means — not the most recent deployment, which may since have
      // succeeded.
      const failed = body.deployments.find((d) => d.status === 'failed')
      if (!failed) {
        throw new CliError(`"${name}" has no failed deployment to explain.`, EXIT.usage)
      }
      deploymentId = failed.id
    }

    const out = await task('reading the failure', () =>
      request<ExplainResponse>('POST', `/fleets/${id}/deployments/${deploymentId}/explain`)
    )
    printExplanation(out.body)
  },
}

type ExplainResponse = {
  status: 'ok' | 'not_worth_it' | 'disabled' | 'rate_limited' | 'failed'
  summary?: string
  steps?: string[]
  cached?: boolean
  hits?: number
  reason?: string
  used?: number
  limit?: number
  resetsInSec?: number
  usage?: { used: number; limit: number }
}

/** Shared by `fleet explain` and by a deploy that just failed. */
export function printExplanation(r: ExplainResponse): void {
  if (r.status === 'ok') {
    console.log()
    for (const line of wrapText(r.summary ?? '', 76)) console.log(`  ${line}`)
    if (r.steps?.length) {
      console.log()
      r.steps.forEach((step, i) => console.log(`  ${c.dim(`${i + 1}.`)} ${step}`))
    }
    const seen = (r.hits ?? 1) > 1 ? `seen ${r.hits}× before` : 'first time this failure has been seen'
    console.log(`\n  ${c.dim(`${r.cached ? 'cached' : 'explained'} · ${seen}`)}`)
    if (r.usage) console.log(`  ${c.dim(`${r.usage.used}/${r.usage.limit} explanations used today`)}`)
    return
  }

  if (r.status === 'rate_limited') {
    const hours = Math.ceil((r.resetsInSec ?? 0) / 3600)
    console.log(
      `\n  ${c.yellow('daily limit reached')} ${c.dim(`— ${r.limit} explanations a day, resets in ${hours}h.`)}`
    )
    console.log(c.dim('  Answers already generated are still free to read.'))
    return
  }

  // disabled / not_worth_it / failed all carry a reason worth printing as-is.
  if (r.reason) console.log(`\n  ${c.dim(r.reason)}`)
}

/** Wrap to a width, on spaces, so a paragraph reads in a terminal. */
function wrapText(text: string, width: number): string[] {
  const out: string[] = []
  for (const paragraph of text.split('\n')) {
    let line = ''
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      if (line && line.length + word.length + 1 > width) {
        out.push(line)
        line = word
      } else {
        line = line ? `${line} ${word}` : word
      }
    }
    if (line) out.push(line)
  }
  return out
}

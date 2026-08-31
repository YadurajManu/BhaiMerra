/**
 * fleet up — one command that takes any repo from zero to a live HTTPS URL.
 *
 * Chains: detect → init → apply → deploy → wait → URL.
 *
 * Every step re-uses the existing CLI primitives (`task`, `splash`, `request`)
 * so the experience is consistent with the granular commands; this just removes
 * the operator from the loop between them.
 */
import { readFile, writeFile, access } from 'node:fs/promises'
import { join } from 'node:path'
import { request, requireFleet, CliError, EXIT } from '../api.js'
import { c } from '../render.js'
import { task, glyph } from '../ui.js'
import { withLadder } from '../ladder.js'
import { DEPLOY_STEPS, follow, phaseWalker } from '../progress.js'
import { planFromManifest, deployOrder } from '../plan.js'
import { uploadContext, humanBytes } from '../archive.js'
import type { Flags } from '../args.js'

type Service = {
  id: string
  name: string
  domain: string | null
  hostname: string | null
  current: { status: string } | null
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export const upCommand = {
  async run(args: string[], flags: Flags) {
    const fleetId = await requireFleet(typeof flags.fleet === 'string' ? flags.fleet : undefined)
    const manifestPath = 'fleet.yaml'

    // ── Step 1: scaffold if needed ────────────────────────────────────
    let needsApply = false
    try {
      await access(manifestPath)
    } catch {
      // No fleet.yaml — run the smart init inline.
      const { detect, manifestTemplate } = await import('../detect.js')
      const d = await task('detecting project framework', async () => detect())

      const name =
        (typeof flags.name === 'string' ? flags.name : '') ||
        args[0] ||
        process.cwd().split('/').pop()?.toLowerCase().replace(/[^a-z0-9-]+/g, '-') ||
        'app'

      // Write Dockerfile if generated
      if (d.dockerfile) {
        await writeFile(join(process.cwd(), 'Dockerfile'), d.dockerfile)
        console.log(`${glyph.ok} ${c.green('created')} Dockerfile  ${c.dim(`(${d.label}, port ${d.port})`)}`)
      }

      // Write manifest
      await writeFile(manifestPath, manifestTemplate(name, d))
      console.log(`${glyph.ok} ${c.green('created')} ${manifestPath}  ${c.dim(`(${d.label})`)}`)
      needsApply = true
    }

    // ── Step 2: read and apply the manifest ───────────────────────────
    const manifest = await readFile(manifestPath, 'utf8')

    const applyResult = await task(
      `applying ${manifestPath}`,
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

    for (const w of applyResult.warnings) {
      console.log(`${glyph.warn} ${c.yellow('warning')}  ${w}`)
    }

    // ── Step 3: decide what to deploy, and in what order ──────────────
    const planned = planFromManifest(manifest)
    const buildContexts = new Map(planned.map((p) => [p.name, p.build]))

    // No argument means the whole stack. A manifest describes a system, and
    // deploying one service of it and leaving the rest was never what anybody
    // wanted — it just meant typing the command again in the right order.
    const targets = args[0] ? [args[0]] : deployOrder(planned)
    if (!targets.length) {
      throw new CliError(
        'The manifest declares no services to deploy.',
        EXIT.usage
      )
    }

    const { body: listBody } = await request<{ services: Service[] }>('GET', `/fleets/${fleetId}/services`)
    const resolved = targets.map((name) => {
      const service = listBody.services.find((s) => s.name === name || s.id === name)
      if (!service) {
        throw new CliError(
          `Service "${name}" not found after apply. Known: ${listBody.services.map((s) => s.name).join(', ')}`,
          EXIT.usage
        )
      }
      return service
    })

    if (resolved.length > 1) {
      console.log(
        `\n  ${c.dim('deploying')} ${resolved.map((s) => c.bold(s.name)).join(c.dim(' → '))}\n`
      )
    }

    const gitSha = typeof flags.sha === 'string' ? flags.sha : undefined
    const deployed: Array<{ service: Service; url: string | null }> = []

    for (const service of resolved) {
      const url = await deployOne(service, {
        fleetId,
        gitSha,
        buildContext: buildContexts.get(service.name),
        wait: !flags['no-wait'],
      })
      deployed.push({ service, url })
    }

    // ── Step 6: print the URLs ────────────────────────────────────────
    for (const { service, url } of deployed) {
      const target = url ?? service.domain ?? service.hostname
      if (!target) continue
      const fullUrl = target.startsWith('http') ? target : `https://${target}`
      console.log(`\n${glyph.ok} ${c.green('live')}  ${c.bold(c.cyan(fullUrl))}`)
    }

    const last = deployed[deployed.length - 1]?.service
    if (last) {
      console.log(c.dim(`\n  fleet open ${last.name}   open in browser`))
      console.log(c.dim(`  fleet logs ${last.name}   follow logs`))
      console.log(c.dim(`  fleet down ${last.name}   tear down`))
    }
  },
}

/**
 * Deploy one service: upload its build context if it has one, run the deploy,
 * and wait for it to report running.
 *
 * Returns the URL the control plane handed back, or null for a service that
 * has none — an internal one, which is reached by name from its neighbours
 * rather than from outside.
 */
async function deployOne(
  service: Service,
  opts: { fleetId: string; gitSha?: string; buildContext?: string; wait: boolean }
): Promise<string | null> {
  // A service that builds from source sends its directory first. The control
  // plane then builds it for every architecture the fleet has, which is the
  // part that is easy to get wrong by hand and silent when you do.
  let contextId: string | undefined
  if (opts.buildContext) {
    const dir = join(process.cwd(), opts.buildContext)
    const uploaded = await task(
      `packaging ${c.bold(service.name)}`,
      async () => uploadContext(service.id, dir),
      { done: (r) => `uploaded ${humanBytes(r.bytes)} of build context` }
    )
    contextId = uploaded.contextId
  }

  const deployResult = await withLadder(
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
          }>('POST', `/services/${service.id}/deploy`, {
            body: { gitSha: opts.gitSha, contextId },
          })
        ).body
        walker.finish(`scheduled onto ${result.placedOn.name}`)
        return result
      } finally {
        await progress.stop()
      }
    },
    {
      mark: true,
      title: `deploying ${service.name}`,
      onCancel: `deploy is still running on the control plane; inspect with fleet deployments ${service.name}`,
    }
  )

  for (const w of deployResult.warnings ?? []) {
    console.log(`${glyph.warn} ${c.yellow('warning')}  ${w}`)
  }

  if (opts.wait) {
    await task(
      `waiting for ${c.bold(service.name)} to come up`,
      async (s) => {
        s.hints([
          'the agent picks up desired state on its next poll',
          "a cold image pull takes as long as the node's uplink does",
          'a service with a health check goes running once it passes, not before',
        ])
        const deadline = Date.now() + 180_000
        while (Date.now() < deadline) {
          const { body } = await request<{ services: Service[] }>(
            'GET',
            `/fleets/${opts.fleetId}/services`
          )
          const current = body.services.find((s) => s.id === service.id)?.current
          if (current?.status === 'running') return
          if (current?.status === 'failed') {
            throw new CliError(
              `"${service.name}" did not start. \`fleet deployments ${service.name}\` has the reason.`,
              EXIT.healthCheckFailed
            )
          }
          await sleep(2000)
        }
        throw new CliError(
          `"${service.name}" was scheduled but has not reported running.`,
          EXIT.healthCheckFailed
        )
      },
      { done: () => `${c.bold(service.name)} is running` }
    )
  }

  return deployResult.url
}

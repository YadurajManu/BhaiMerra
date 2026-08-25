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
import { task, splash, glyph } from '../ui.js'
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

    // ── Step 3: pick the target service ───────────────────────────────
    const serviceName = args[0] || applyResult.created[0] || applyResult.updated[0]
    if (!serviceName) {
      throw new CliError(
        'Could not determine which service to deploy. Pass the name: fleet up <service>',
        EXIT.usage
      )
    }

    // Look it up
    const { body: listBody } = await request<{ services: Service[] }>('GET', `/fleets/${fleetId}/services`)
    const service = listBody.services.find((s) => s.name === serviceName || s.id === serviceName)
    if (!service) {
      throw new CliError(
        `Service "${serviceName}" not found after apply. Known: ${listBody.services.map((s) => s.name).join(', ')}`,
        EXIT.usage
      )
    }

    // ── Step 4: deploy ────────────────────────────────────────────────
    const gitSha = typeof flags.sha === 'string' ? flags.sha : undefined

    const deployResult = await splash(
      `deploying ${c.bold(service.name)}`,
      async () =>
        (
          await request<{
            placedOn: { name: string }
            score: number
            url: string | null
            warnings: string[]
          }>('POST', `/services/${service.id}/deploy`, { body: { gitSha } })
        ).body,
      {
        hints: [
          'scoring every online node on headroom, reliability and load',
          'building for every architecture an eligible node runs',
          'the first multi-arch build is the slow one; layers cache after it',
          'pushing the image to the fleet registry',
        ],
        done: (b) => `built and scheduled onto ${c.bold(b.placedOn.name)} ${c.dim(`score ${b.score?.toFixed(3)}`)}`,
      }
    )

    for (const w of deployResult.warnings ?? []) {
      console.log(`${glyph.warn} ${c.yellow('warning')}  ${w}`)
    }

    // ── Step 5: wait for healthy ──────────────────────────────────────
    if (!flags['no-wait']) {
      await task(
        `waiting for ${c.bold(service.name)} to come up`,
        async (s) => {
          s.hints([
            'the agent picks up desired state on its next poll',
            "a cold image pull takes as long as the node's uplink does",
            'this clears once the agent reports the container running',
          ])
          const deadline = Date.now() + 180_000
          while (Date.now() < deadline) {
            const { body } = await request<{ services: Service[] }>('GET', `/fleets/${fleetId}/services`)
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

    // ── Step 6: print the URL ─────────────────────────────────────────
    const url = deployResult.url ?? service.domain ?? service.hostname
    if (url) {
      const fullUrl = url.startsWith('http') ? url : `https://${url}`
      console.log(`\n${glyph.ok} ${c.green('live')}  ${c.bold(c.cyan(fullUrl))}`)
    }

    console.log(c.dim(`\n  fleet open ${service.name}   open in browser`))
    console.log(c.dim(`  fleet logs ${service.name}   follow logs`))
    console.log(c.dim(`  fleet down ${service.name}   tear down`))
  },
}

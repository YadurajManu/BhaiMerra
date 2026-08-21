import { CliError, EXIT, request, requireFleet } from '../api.js'
import { loadProfile } from '../config.js'
import { c, relativeTime } from '../render.js'
import { glyph, rule, task } from '../ui.js'
import type { Flags } from '../args.js'

type CheckState = 'ok' | 'warn' | 'fail'
type Check = { state: CheckState; label: string; detail: string; remedy?: string }
type Node = { name: string; status: string; live: boolean; lastHeartbeatAt: string | null; agentVersion: string | null; telemetry: unknown }
type Service = { id: string; name: string; domain: string | null; hostname: string | null; current: { status: string } | null }
type Deployment = { status: string; failureReason: string | null; startedAt: string }

const icon = (state: CheckState) =>
  state === 'ok' ? glyph.ok : state === 'warn' ? glyph.warn : glyph.fail

async function reach(url: string): Promise<{ ok: boolean; detail: string }> {
  try {
    const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(8_000) })
    return { ok: true, detail: `HTTPS answered ${response.status}` }
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * A candid, read-only diagnosis. A check is never marked healthy merely
 * because Fleet lacks enough telemetry to prove it — that is a warning with
 * the next concrete product capability stated plainly.
 */
export const doctorCommand = {
  async run(_args: string[], flags: Flags) {
    const profile = await loadProfile()
    const fleetId = await requireFleet(typeof flags.fleet === 'string' ? flags.fleet : undefined)

    const result = await task('checking Fleet health', async () => {
      const [identity, fleet, nodes, services, github] = await Promise.all([
        request<{ user: { email: string } }>('GET', '/auth/me'),
        request<{ fleet: { name: string }; role: string }>('GET', `/fleets/${fleetId}`),
        request<{ nodes: Node[] }>('GET', `/fleets/${fleetId}/nodes`),
        request<{ services: Service[] }>('GET', `/fleets/${fleetId}/services`),
        request<{ configured: boolean; error?: string; installations?: unknown[] }>('GET', `/fleets/${fleetId}/github/status`),
      ])

      const deploymentHistory = await Promise.all(
        services.body.services.map(async (service) => ({
          service,
          deployments: (await request<{ deployments: Deployment[] }>('GET', `/services/${service.id}/deployments`)).body.deployments,
        }))
      )
      const urls = services.body.services
        .map((service) => ({ name: service.name, hostname: service.domain ?? service.hostname }))
        .filter((service): service is { name: string; hostname: string } => Boolean(service.hostname))
      const ingress = await Promise.all(urls.map(async (service) => ({ ...service, ...(await reach(`https://${service.hostname}`)) })))
      return { identity: identity.body, fleet: fleet.body, nodes: nodes.body.nodes, services: services.body.services, github: github.body, deploymentHistory, ingress }
    })

    const checks: Check[] = [
      { state: 'ok', label: 'control plane', detail: profile.api },
      { state: 'ok', label: 'signed in', detail: result.identity.user.email },
      { state: 'ok', label: 'fleet access', detail: `${result.fleet.fleet.name} · ${result.fleet.role}` },
    ]

    if (!result.nodes.length) {
      checks.push({ state: 'fail', label: 'nodes', detail: 'No nodes are paired.', remedy: 'Run `fleet nodes pair`, then run the printed command on a machine you own.' })
    } else {
      const offline = result.nodes.filter((node) => node.status === 'offline' || !node.live)
      const cordoned = result.nodes.filter((node) => node.status === 'cordoned')
      const versions = new Set(result.nodes.map((node) => node.agentVersion).filter(Boolean))
      checks.push({
        state: offline.length ? 'fail' : cordoned.length ? 'warn' : 'ok',
        label: 'nodes',
        detail: offline.length
          ? `${offline.map((node) => `${node.name} (${relativeTime(node.lastHeartbeatAt)})`).join(', ')} not reporting`
          : cordoned.length
            ? `${result.nodes.length} paired; ${cordoned.map((node) => node.name).join(', ')} cordoned`
            : `${result.nodes.length} paired and reporting`,
        remedy: offline.length ? 'Check the agent service and its outbound connection, then run `fleet doctor` again.' : undefined,
      })
      checks.push({
        state: versions.size > 1 ? 'warn' : 'ok',
        label: 'agent versions',
        detail: versions.size ? [...versions].join(', ') : 'agent version not reported',
        remedy: versions.size > 1 ? 'Update nodes so all agents run the same compatible release.' : undefined,
      })
      checks.push({
        state: 'warn',
        label: 'container runtime',
        detail: 'Remote Docker health is not reported by this agent version.',
        remedy: 'Fleet will add explicit Docker and registry probes to agent heartbeats; for now inspect the agent log on each affected node.',
      })
    }

    const failed = result.deploymentHistory.flatMap(({ service, deployments }) =>
      deployments.filter((deployment) => deployment.status === 'failed' || deployment.failureReason).slice(0, 1).map((deployment) => ({ service: service.name, deployment }))
    )
    checks.push(
      failed.length
        ? {
            state: 'fail',
            label: 'deployments',
            detail: failed.map(({ service, deployment }) => `${service}: ${deployment.failureReason ?? deployment.status}`).join('; '),
            remedy: 'Run `fleet deployments <service>` for history. Centralized `fleet logs` is the next diagnostic surface.',
          }
        : { state: 'ok', label: 'deployments', detail: result.services.length ? 'No recorded deployment failures.' : 'No services declared yet.' }
    )

    if (!result.ingress.length) {
      checks.push({ state: 'warn', label: 'ingress', detail: 'No public service hostname is configured yet.' })
    } else {
      for (const service of result.ingress) {
        checks.push({
          state: service.ok ? 'ok' : 'fail',
          label: `HTTPS ${service.name}`,
          detail: service.detail,
          remedy: service.ok ? undefined : 'Check the node is online, its advertised address is reachable, and the ingress domain resolves to this control plane.',
        })
      }
    }

    checks.push(
      result.github.configured && !result.github.error
        ? { state: 'ok', label: 'GitHub App', detail: `${result.github.installations?.length ?? 0} installation(s) available` }
        : {
            state: 'warn',
            label: 'GitHub App',
            detail: result.github.error ?? 'Not configured; public repositories can still deploy.',
            remedy: 'Set GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY, restart the control plane, then connect repositories in Dashboard → Settings.',
          }
    )
    checks.push({
      state: 'warn',
      label: 'registry and secrets',
      detail: 'Agent-side registry reachability and a secret inventory are not yet exposed to doctor.',
      remedy: 'Use a registry address reachable from every node—not localhost. The next agent telemetry release will verify this automatically.',
    })

    if (flags.json) return console.log(JSON.stringify({ fleetId, checks }, null, 2))
    console.log(`\n${rule(`doctor · ${result.fleet.fleet.name}`)}`)
    for (const check of checks) {
      console.log(`${icon(check.state)} ${c.bold(check.label.padEnd(18))} ${check.detail}`)
      if (check.remedy) console.log(`  ${c.dim(check.remedy)}`)
    }
    const failing = checks.filter((check) => check.state === 'fail').length
    const warnings = checks.filter((check) => check.state === 'warn').length
    console.log(`\n${failing ? c.red(`${failing} failed`) : c.green('no blocking failures')}${warnings ? c.dim(` · ${warnings} needs attention`) : ''}`)
    if (failing) process.exitCode = EXIT.failure
  },
}

import { CliError, EXIT, request, requireFleet } from '../api.js'
import { loadProfile } from '../config.js'
import { c, relativeTime } from '../render.js'
import { glyph, rule, task } from '../ui.js'
import type { Flags } from '../args.js'

type CheckState = 'ok' | 'warn' | 'fail'
type Check = { state: CheckState; label: string; detail: string; remedy?: string }
type Node = { name: string; status: string; live: boolean; lastHeartbeatAt: string | null; agentVersion: string | null; diskMb: number; telemetry: { diskUsedMb: number; runtime: { dockerAvailable: boolean; dockerVersion?: string; dockerError?: string; registryStatus?: 'ok' | 'failed' | 'not_tested'; registryError?: string; lastReconcileError?: string } } | null }
type Candidate = { path: string; status: number; bytes: number }
type Service = {
  id: string
  name: string
  domain: string | null
  hostname: string | null
  current: { status: string } | null
  healthDisabled?: boolean
  discoveredHealth?: Candidate[] | null
}
type Deployment = { status: string; failureReason: string | null; startedAt: string }

const icon = (state: CheckState) =>
  state === 'ok' ? glyph.ok : state === 'warn' ? glyph.warn : glyph.fail

/**
 * Services that answer on a health path but do not declare one.
 *
 * `fleet init` writes this into every manifest it generates:
 *
 *   # No health check: container state decides whether this is up.
 *   # Add one once you know a path that returns 2xx —
 *
 * That is a research task handed to the reader, about a program the node is
 * already running. The node does the research now -- it asks the container
 * which of a handful of paths answers -- and this is where the answer is
 * reported, because the sweep settles seconds after a deploy returns and there
 * is nothing useful to say while it is still running.
 *
 * The negative result is deliberately not a warning. A service where nothing
 * answered is a service whose manifest is already correct, and telling somebody
 * their correct configuration is a problem is how a health report gets ignored.
 *
 * Separated from the command so both outcomes can be tested without a control
 * plane -- and the one that matters is the suggestion, which a fleet whose
 * services all declare health checks never produces.
 */
export function healthPathCheck(services: Service[]): {
  state: 'ok' | 'warn'
  label: string
  detail: string
  remedy?: string
} {
  const swept = services.filter((s) => s.discoveredHealth)
  const answering = swept
    .map((s) => ({
      name: s.name,
      // The first 2xx-3xx, which is the order the node tried them in: a
      // dedicated endpoint before "/", because a check that renders the whole
      // application every ten seconds is the worse of two working answers.
      path: s.discoveredHealth!.find((c) => c.status >= 200 && c.status < 400)?.path,
    }))
    .filter((s): s is { name: string; path: string } => Boolean(s.path))

  if (!answering.length) {
    return {
      state: 'ok',
      label: 'health paths',
      detail: swept.length
        ? `${swept.length} service(s) without a health check answered nothing — container state is the only evidence, as declared.`
        : 'Every service declares a health check, or none has been swept yet.',
    }
  }

  const named = answering.map((s) => `${s.name} → ${s.path}`).join(', ')
  return {
    state: 'warn',
    label: 'health paths',
    detail: `${named}. These answer 2xx but declare no health check, so a deploy is confirmed on container state alone.`,
    remedy: `Add \`health: { path: ${answering[0]!.path} }\` to ${answering[0]!.name} in fleet.yaml. Without one, a container that starts and then fails every request still counts as a successful deploy.`,
  }
}

/**
 * A build failure carries the whole buildx transcript. One summary line
 * belongs in a health report; `fleet deployments` is where the rest lives.
 */
function firstLine(text: string): string {
  const line = text.split('\n').find((l) => l.trim()) ?? text
  return line.length > 160 ? `${line.slice(0, 157)}…` : line
}

/**
 * Statuses an edge returns when it could not reach the origin at all.
 * Cloudflare's 52x range and 530 mean the tunnel is down; 502/503/504 mean the
 * same thing from any reverse proxy.
 */
const ORIGIN_UNREACHABLE = new Set([502, 503, 504, 520, 521, 522, 523, 524, 525, 526, 527, 530])

/**
 * Is the service reachable through the ingress?
 *
 * That question is not "did it return 200". An API with no route at `/` answers
 * 404, and a 404 from the *application* is proof the whole chain works —
 * ingress, tunnel, agent, container. Reporting that as a failure sends people
 * to check DNS and node health when nothing is wrong, which is exactly what it
 * did for an API whose /health returned 200 the whole time.
 *
 * What does indicate a broken path is the edge answering on the origin's
 * behalf, or nothing answering at all.
 */
/**
 * Whether this fleet can tell anybody something went wrong.
 *
 * A fleet with no alert rules fails silently, and the only way to find out is
 * an outage. This one had none while its services went down four times in an
 * afternoon: the empty state existed, and lived inside `fleet alerts`, a
 * subcommand you only run once you already suspect the answer.
 *
 * Separated from the command so both outcomes can be tested without a control
 * plane — the one that matters is the warning, and it is the one a live check
 * against a working fleet never exercises.
 */
export function alertCheck(rules: Array<{ channelType: string; enabled: boolean }>): {
  state: 'ok' | 'warn'
  label: string
  detail: string
  remedy?: string
} {
  const live = rules.filter((r) => r.enabled)
  if (live.length) {
    return {
      state: 'ok',
      label: 'alerts',
      detail: `${live.length} rule(s): ${[...new Set(live.map((r) => r.channelType))].join(', ')}`,
    }
  }
  return {
    state: 'warn',
    label: 'alerts',
    // Disabled and absent are different mistakes: one was set up and turned
    // off, the other never existed, and the person reading needs to know which.
    detail: rules.length
      ? 'Every alert rule is disabled — failures will pass unreported.'
      : 'No alert rules. A node going down or a deploy failing will tell nobody.',
    remedy:
      'Add one with `fleet alerts add --channel email --to you@example.com`, then prove it with `fleet alerts test`.',
  }
}

async function reach(url: string): Promise<{ ok: boolean; detail: string }> {
  try {
    const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(8_000) })
    const status = response.status

    if (ORIGIN_UNREACHABLE.has(status)) {
      return { ok: false, detail: `HTTPS answered ${status} — the edge could not reach the container` }
    }
    if (status >= 200 && status < 400) {
      return { ok: true, detail: `HTTPS answered ${status}` }
    }
    if (status < 500) {
      // The application answered. It has an opinion about the request, which
      // means everything in front of it is working.
      return { ok: true, detail: `HTTPS answered ${status} — reachable; the app has no route there` }
    }
    return { ok: false, detail: `HTTPS answered ${status} — reachable, but the app is erroring` }
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
      const [identity, fleet, nodes, services, github, health, alerts] = await Promise.all([
        request<{ user: { email: string } }>('GET', '/auth/me'),
        request<{ fleet: { name: string }; role: string }>('GET', `/fleets/${fleetId}`),
        request<{ nodes: Node[] }>('GET', `/fleets/${fleetId}/nodes`),
        request<{ services: Service[] }>('GET', `/fleets/${fleetId}/services`),
        request<{ configured: boolean; error?: string; installations?: unknown[] }>('GET', `/fleets/${fleetId}/github/status`),
        request<{ version?: string }>('GET', '/healthz'),
        request<{ rules: Array<{ channelType: string; enabled: boolean }> }>(
          'GET',
          `/fleets/${fleetId}/alert-rules`
        ),
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
      return { identity: identity.body, fleet: fleet.body, nodes: nodes.body.nodes, services: services.body.services, github: github.body, health: health.body, alerts: alerts.body.rules, deploymentHistory, ingress }
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
      for (const node of result.nodes) {
        const runtime = node.telemetry?.runtime
        const diskPercent = node.diskMb ? Math.round(((node.telemetry?.diskUsedMb ?? 0) / node.diskMb) * 100) : 0
        // Redis intentionally retains the last heartbeat briefly, but a node
        // that has stopped reporting must not have old host facts rendered as
        // current failures. The heartbeat check above is the only actionable
        // check until the agent resumes.
        if (!node.live || !node.telemetry) {
          checks.push({
            state: 'warn',
            label: `runtime ${node.name}`,
            detail: 'Unavailable because this node is not reporting a current heartbeat.',
            remedy: 'Restart the agent, then run `fleet doctor` again for live Docker, registry, and disk checks.',
          })
          continue
        }
        checks.push({ state: runtime?.dockerAvailable ? 'ok' : 'fail', label: `Docker ${node.name}`, detail: runtime?.dockerAvailable ? `available${runtime.dockerVersion ? ` · ${runtime.dockerVersion}` : ''}` : runtime?.dockerError ?? 'No Docker runtime reported', remedy: runtime?.dockerAvailable ? undefined : 'Start Docker, then inspect the local fleet-agent log.' })
        checks.push({ state: runtime?.registryStatus === 'ok' ? 'ok' : runtime?.registryStatus === 'failed' ? 'fail' : 'warn', label: `registry ${node.name}`, detail: runtime?.registryStatus === 'ok' ? 'latest real image pull succeeded' : runtime?.registryError ?? 'not tested by a real image pull yet', remedy: runtime?.registryStatus === 'ok' ? undefined : 'Use a LAN-reachable REGISTRY_URL, then restart a service to run an authenticated pull.' })
        checks.push({ state: diskPercent >= 90 ? 'fail' : diskPercent >= 80 ? 'warn' : 'ok', label: `disk ${node.name}`, detail: `${diskPercent}% used`, remedy: diskPercent >= 80 ? 'Free space from Docker images/volumes before the node becomes unschedulable.' : undefined })
        if (runtime?.lastReconcileError) checks.push({ state: 'fail', label: `reconcile ${node.name}`, detail: runtime.lastReconcileError, remedy: 'Run `fleet logs <service> --follow` and inspect the deployment history.' })
      }
    }

    // Only the *current* deployment of each service can be a current problem.
    // Scanning the whole history meant a service that failed once and then
    // deployed successfully still reported the old failure, so a healthy fleet
    // showed a wall of buildx output from a build that had since been redone.
    const failed = result.deploymentHistory.flatMap(({ service, deployments }) => {
      const latest = deployments[0]
      if (!latest) return []
      const isFailure = latest.status === 'failed' || Boolean(latest.failureReason)
      return isFailure ? [{ service: service.name, deployment: latest }] : []
    })
    checks.push(
      failed.length
        ? {
            state: 'fail',
            label: 'deployments',
            detail: failed
              .map(({ service, deployment }) => `${service}: ${firstLine(deployment.failureReason ?? deployment.status)}`)
              .join('; '),
            remedy: 'Run `fleet deployments <service>` for history and `fleet logs <service> --follow` for the current container tail.',
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
    checks.push(healthPathCheck(result.services))
    checks.push(alertCheck(result.alerts))

    checks.push({ state: 'ok', label: 'control-plane version', detail: result.health.version ?? 'version not reported' })

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

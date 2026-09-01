import { api, type Node, type Service } from '../lib/api'
import { useAuth, usePoll } from '../lib/auth'
import { Copyable, Panel } from '../components/ui'

type Check = { tone: 'good' | 'warn' | 'bad'; title: string; detail: string; repair?: string }

/** A build failure carries its whole transcript; a health report gets a line. */
const firstLine = (text: string) => {
  const line = text.split('\n').find((l) => l.trim()) ?? text
  return line.length > 160 ? `${line.slice(0, 157)}…` : line
}

/**
 * What the deployments say, which is where an outage actually shows up.
 *
 * A node can be online, Docker healthy, disk fine and the registry reachable
 * while every service on it is down — that was exactly the state this fleet
 * was in, and this page reported no problems at all.
 */
function deploymentChecks(services: Service[]): Check[] {
  if (!services.length) return [{ tone: 'good', title: 'deployments', detail: 'No services declared yet.' }]

  const down = services.filter(
    (s) => s.current?.status !== 'running' && s.current?.status !== 'online' && s.current?.status !== 'deploying'
  )
  if (!down.length) {
    return [{ tone: 'good', title: 'deployments', detail: `All ${services.length} service(s) are running.` }]
  }

  return down.map((s) => ({
    tone: 'bad' as const,
    title: `${s.name}: not running`,
    detail: s.last?.failureReason
      ? firstLine(s.last.failureReason)
      : s.last
        ? `Last deployment ended as "${s.last.status}".`
        : 'This service has never been deployed.',
    repair: `fleet logs ${s.name} --follow`,
  }))
}

export default function Doctor() {
  const { fleet } = useAuth()
  const data = usePoll(() => api<{ nodes: Node[] }>(`/fleets/${fleet?.id}/nodes`), [fleet?.id], 5000)
  // The CLI's doctor checks deployments and reachability; this one did not, so
  // the terminal told you more about your own fleet than the dashboard did.
  const services = usePoll(() => api<{ services: Service[] }>(`/fleets/${fleet?.id}/services`), [fleet?.id], 8000)
  const github = usePoll(() => api<{ configured: boolean; error?: string; installations?: unknown[] }>(`/fleets/${fleet?.id}/github/status`), [fleet?.id], 15000)
  const nodes = data.data?.nodes ?? []
  const checks: Check[] = [github.data?.configured
    ? { tone: 'good', title: 'GitHub App', detail: `${github.data.installations?.length ?? 0} installation(s) available for deploys.` }
    : { tone: 'warn', title: 'GitHub App', detail: github.data?.error ?? 'Not configured; public repositories still work.', repair: 'Configure GITHUB_APP_ID and its private key, then reconnect your repository.' }, ...nodes.flatMap((n) => {
    const runtime = n.telemetry?.runtime
    const diskPercent = n.diskMb ? Math.round(((n.telemetry?.diskUsedMb ?? 0) / n.diskMb) * 100) : 0
    return [
      !n.live ? { tone: 'bad', title: `${n.name}: agent heartbeat`, detail: 'This node is not reporting heartbeats and cannot receive deployments.', repair: `fleet nodes pair  # pair a healthy agent, then inspect its local agent log` } : { tone: 'good', title: `${n.name}: agent heartbeat`, detail: `Reporting ${Math.round((n.telemetry?.ageMs ?? 0) / 1000)}s ago.` },
      !runtime?.dockerAvailable ? { tone: 'bad', title: `${n.name}: Docker daemon`, detail: runtime?.dockerError ?? 'The agent has not reported Docker availability.', repair: 'Start Docker Desktop (macOS/Windows) or: sudo systemctl enable --now docker' } : { tone: 'good', title: `${n.name}: Docker daemon`, detail: `Available${runtime.dockerVersion ? ` · Docker ${runtime.dockerVersion}` : ''}.` },
      runtime?.registryStatus === 'failed' ? { tone: 'bad', title: `${n.name}: registry image pull`, detail: runtime.registryError ?? 'The last authenticated pull failed.', repair: 'Check REGISTRY_URL and REGISTRY_CREDENTIALS, then fleet restart <service>.' } : runtime?.registryStatus === 'ok' ? { tone: 'good', title: `${n.name}: registry image pull`, detail: 'The latest reconciliation completed an image pull.' } : { tone: 'warn', title: `${n.name}: registry image pull`, detail: 'Not tested yet — deploy or restart a service to run a real authenticated pull.', repair: 'fleet restart <service>' },
      diskPercent >= 90 ? { tone: 'bad', title: `${n.name}: disk pressure`, detail: `${diskPercent}% of node disk is currently used.`, repair: 'Free Docker images/volumes, then verify with fleet doctor.' } : diskPercent >= 80 ? { tone: 'warn', title: `${n.name}: disk pressure`, detail: `${diskPercent}% of node disk is currently used.` } : { tone: 'good', title: `${n.name}: disk pressure`, detail: `${diskPercent}% of node disk is currently used.` },
      runtime?.lastReconcileError ? { tone: 'bad', title: `${n.name}: last reconciliation`, detail: firstLine(runtime.lastReconcileError), repair: 'fleet logs <service> --follow' } : { tone: 'good', title: `${n.name}: last reconciliation`, detail: 'No error reported by the agent.' },
      // The reverse tunnel is what carries ingress to this node. It was
      // reported nowhere in the dashboard, and the mesh flag that stood in for
      // it on the topology view is never set by the agent.
      n.live && !n.tunnelConnected
        ? { tone: 'warn', title: `${n.name}: reverse tunnel`, detail: 'The node is heartbeating but holds no tunnel, so ingress cannot reach it.', repair: 'Check the agent log for "reverse tunnel disconnected" and confirm the node can reach the control plane over wss://.' }
        : n.live
          ? { tone: 'good', title: `${n.name}: reverse tunnel`, detail: 'Connected; ingress can reach this node.' }
          : { tone: 'bad', title: `${n.name}: reverse tunnel`, detail: 'Not connected — the node is not reporting at all.' },
    ] as Check[]
  }),
  // Deployment health, which the CLI has always reported and this page never did.
  ...deploymentChecks(services.data?.services ?? [])]
  return <div className="space-y-6"><div><h1 className="font-mono text-[22px]">Doctor</h1><p className="mt-1 text-[14px] text-[var(--color-fg-muted)]">Live health facts reported by agents — no inferred green checks.</p></div><Panel title="fleet health centre"><div className="divide-y divide-[var(--color-line)]">{checks.map((check, i) => <div key={i} className="px-5 py-4"><div className="flex items-center gap-2 font-mono text-[12px]"><span className={check.tone === 'good' ? 'text-[var(--color-signal)]' : check.tone === 'warn' ? 'text-[var(--color-warn)]' : 'text-[var(--color-down)]'}>{check.tone === 'good' ? '●' : check.tone === 'warn' ? '▲' : '×'}</span>{check.title}</div><p className="mt-1 text-[12px] text-[var(--color-fg-muted)]">{check.detail}</p>{check.repair && <div className="mt-3 flex items-center gap-2 font-mono text-[10.5px] text-[var(--color-fg-dim)]"><code>{check.repair}</code><Copyable text={check.repair} /></div>}</div>)}{!checks.length && <p className="px-5 py-8 text-center text-[var(--color-fg-dim)]">No nodes are paired yet.</p>}</div></Panel></div>
}

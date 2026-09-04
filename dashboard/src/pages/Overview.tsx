import { Link, useNavigate } from 'react-router-dom'
import { api, type Node, type PlacementMapNode, type Service, type TimelineEvent } from '../lib/api'
import { useAuth, usePoll } from '../lib/auth'
import { mb, pct, since, toneOf } from '../lib/format'
import { Dot, Empty, ErrorNote, GridFiller, Meter, Panel, StatusPill, Button } from '../components/ui'
import ClusterMeshVisualizer from '../components/ClusterMeshVisualizer'
import FirstRun from '../components/FirstRun'

export default function Overview() {
  const { fleet } = useAuth()
  const id = fleet?.id

  const map = usePoll(
    () => api<{ nodes: PlacementMapNode[]; unplaced: string[] }>(`/fleets/${id}/placement-map`),
    [id]
  )
  const nodes = usePoll(() => api<{ nodes: Node[] }>(`/fleets/${id}/nodes`), [id])
  const events = usePoll(() => api<{ events: TimelineEvent[] }>(`/fleets/${id}/events?limit=8`), [id], 8000)
  // Needed to lead with what is wrong. The placement map only knows about
  // services that got placed, so a service whose deployment failed is simply
  // absent from it — which is how four of them were down with the Overview
  // reporting nothing at all.
  const services = usePoll(() => api<{ services: Service[] }>(`/fleets/${id}/services`), [id], 8000)
  // Polled slowly: this changes when somebody configures it, not on its own.
  const alerts = usePoll(
    () => api<{ rules: Array<{ enabled: boolean }> }>(`/fleets/${id}/alert-rules`),
    [id],
    60_000
  )
  const navigate = useNavigate()

  if (!id) return <Empty title="No fleet selected" />
  if (map.error) return <ErrorNote error={map.error} />

  const mapNodes = map.data?.nodes ?? []
  const all = nodes.data?.nodes ?? []

  // An empty fleet gets the guide rather than a dead end. The old state named
  // the problem and offered one button, and everything after that button -
  // mint a token, find the installer, learn a manifest format, apply it, then
  // deploy - was left to be discovered.
  if (!map.loading && fleet && (!mapNodes.length || !(services.data?.services ?? []).length)) {
    return (
      <div className="space-y-5">
        <div>
          <h1 className="text-[22px] font-semibold tracking-[-0.03em]">Welcome to {fleet.name}</h1>
          <p className="mt-1 text-[13.5px] text-[var(--color-fg-muted)]">
            Two steps to something of your own running on hardware you control.
          </p>
        </div>
        <FirstRun
          fleet={fleet}
          nodes={all}
          services={services.data?.services ?? []}
          onChanged={() => services.refetch()}
        />
      </div>
    )
  }

  const offline = mapNodes.filter((n) => n.status === 'offline')
  const pinnedDown = mapNodes.flatMap((n) =>
    n.services.filter((s) => s.status === 'pinned_unavailable').map((s) => ({ node: n.name, service: s.name }))
  )
  const totalServices = mapNodes.reduce((sum, n) => sum + n.services.length, 0)

  // Declared but not running, and not already explained by a pinned node
  // being down. This is the case the Overview was blind to.
  const allServices = services.data?.services ?? []
  const broken = allServices.filter(
    (s) =>
      s.current?.status !== 'running' &&
      s.current?.status !== 'online' &&
      s.current?.status !== 'deploying' &&
      !pinnedDown.some((p) => p.service === s.name)
  )

  const canAlert = (alerts.data?.rules ?? []).some((r) => r.enabled)

  return (
    <div className="space-y-6">
      {/* Nothing is wrong yet, and nothing will say so when it is.

          The rules, the channels and the delivery all existed; this fleet
          simply had none configured, and found out by watching services go
          down four times in an afternoon. The empty state was written — inside
          `fleet alerts`, a command you only run once you already suspect the
          answer. Shown here because this is the page people actually open.

          Only once the fleet has something to lose: a brand new fleet with no
          services does not need telling, and a warning on an empty screen is
          how people learn to dismiss warnings. */}
      {alerts.data && !canAlert && (services.data?.services.length ?? 0) > 0 && (
        <Link
          to="/alerts"
          className="fade-up block border-l-2 border-[var(--color-warn)] bg-[color-mix(in_oklab,var(--color-warn)_6%,transparent)] px-5 py-4 transition-colors hover:bg-[color-mix(in_oklab,var(--color-warn)_10%,transparent)]"
        >
          <div className="font-mono text-[10px] uppercase tracking-[0.14em] text-[var(--color-warn)]">
            no alerts configured
          </div>
          <p className="mt-2 text-[14px] leading-relaxed">
            A node going down or a deploy failing will tell nobody. Add a rule →
          </p>
        </Link>
      )}

      {/* Something is wrong and nothing said so until you went looking. */}
      {broken.length > 0 && (
        <Link
          to="/services"
          className="fade-up block border-l-2 border-[var(--color-down)] bg-[color-mix(in_oklab,var(--color-down)_7%,transparent)] px-5 py-4 transition-colors hover:bg-[color-mix(in_oklab,var(--color-down)_11%,transparent)]"
        >
          <div className="font-mono text-[10px] uppercase tracking-[0.14em] text-[var(--color-down)]">
            {broken.length} service{broken.length === 1 ? '' : 's'} not running
          </div>
          <p className="mt-2 text-[14px] leading-relaxed">
            {broken
              .slice(0, 4)
              .map((s) => s.name)
              .join(', ')}
            {broken.length > 4 && ` and ${broken.length - 4} more`}
            <span className="block text-[13px] text-[var(--color-fg-muted)]">
              {broken[0]?.last?.failureReason
                ? broken[0].last.failureReason.split('\n')[0]?.slice(0, 120)
                : 'Open Services to see why each one stopped.'}
            </span>
          </p>
        </Link>
      )}

      {/* What needs a human comes first, always. */}
      {pinnedDown.length > 0 && (
        <div className="fade-up border-l-2 border-[var(--color-down)] bg-[color-mix(in_oklab,var(--color-down)_7%,transparent)] px-5 py-4">
          <div className="font-mono text-[10px] uppercase tracking-[0.14em] text-[var(--color-down)]">
            needs attention
          </div>
          {pinnedDown.map((p) => (
            <p key={p.service} className="mt-2 text-[14px] leading-relaxed">
              <span className="font-medium">{p.service}</span> is down and was{' '}
              <span className="text-[var(--color-down)]">not moved</span> — it is pinned to{' '}
              <span className="font-mono text-[13px]">{p.node}</span>.
              <span className="block text-[13px] text-[var(--color-fg-muted)]">
                Pinned services stay with their data. Bring that node back, or repin the service.
              </span>
            </p>
          ))}
        </div>
      )}

      {/* fleet summary */}
      <div className="grid gap-px bg-[var(--color-line)] sm:grid-cols-2 lg:grid-cols-4">
        {[
          ['nodes online', `${mapNodes.length - offline.length} / ${mapNodes.length}`, offline.length ? 'warn' : 'ok'],
          // "services placed 0" is a true statement that hides the news. What
          // matters is how many of the declared services are actually up.
          [
            'services running',
            allServices.length ? `${totalServices} / ${allServices.length}` : String(totalServices),
            broken.length ? 'warn' : 'idle',
          ],
          ['unplaced', String(map.data?.unplaced.length ?? 0), map.data?.unplaced.length ? 'warn' : 'idle'],
          ['heartbeat', `${fleet.heartbeatIntervalSec}s × ${fleet.heartbeatMissThreshold}`, 'idle'],
        ].map(([label, value, tone]) => (
          <div key={label} className="bg-[var(--color-ink-950)] px-5 py-4">
            <div className="mono-label normal-case tracking-[0.08em]">{label}</div>
            <div className="mt-2 flex items-center gap-2">
              {tone !== 'idle' && <Dot tone={tone as 'ok' | 'warn'} size={6} />}
              <span className="tabular text-[20px] font-semibold tracking-[-0.03em]">{value}</span>
            </div>
          </div>
        ))}
      </div>

      {/* Interactive cluster mesh topology */}
      <Panel title="cluster mesh" right={
        <span className="inline-flex items-center gap-1.5 font-mono text-[10px] normal-case">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[var(--color-signal)]" />
          live
        </span>
      }>
        <ClusterMeshVisualizer
          mapNodes={mapNodes}
          nodes={all}
          fleetName={fleet.name}
          onSelectNode={() => navigate('/nodes')}
          onSelectService={(name) => {
            const match = allServices.find((s) => s.name === name)
            navigate(match ? `/services/${match.id}` : '/services')
          }}
        />
      </Panel>

      <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
        {/* placement map — the picture of where everything is */}
        <Panel title="placement map" right={<span className="font-mono text-[10px] normal-case">{fleet.name}</span>}>
          <div className="grid gap-px bg-[var(--color-line)] [&>*]:min-h-full sm:grid-cols-2">
            {mapNodes.map((n) => {
              const node = all.find((x) => x.id === n.id)
              const used = n.ramMb - n.freeRamMb
              return (
                <div
                  key={n.id}
                  className="bg-[var(--color-ink-950)] p-5 transition-colors duration-500"
                  style={
                    n.status === 'offline'
                      ? { background: 'color-mix(in oklab, var(--color-down) 5%, var(--color-ink-950))' }
                      : undefined
                  }
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 font-mono text-[12.5px]">
                        <Dot tone={toneOf(n.status)} size={6} />
                        <span className="truncate">{n.name}</span>
                      </div>
                      <div className="mt-1.5 pl-[14px] font-mono text-[9.5px] tracking-[0.08em] text-[var(--color-fg-dim)]">
                        {n.arch} · {n.reliabilityTier}
                        {node?.hasGpu ? ' · gpu' : ''}
                      </div>
                    </div>
                    <StatusPill status={n.status} />
                  </div>

                  <div className="mt-4 space-y-2">
                    <Meter value={used} max={n.ramMb} label={`${mb(used)} / ${mb(n.ramMb)}`} />
                    <Meter value={n.loadFactor ?? 0} max={1} label={`cpu ${pct(n.loadFactor)}`} />
                  </div>

                  <div className="mt-4 flex flex-wrap gap-1.5">
                    {n.services.length ? (
                      n.services.map((s) => (
                        <span
                          key={s.name}
                          className={`inline-flex items-center gap-1.5 border px-2 py-1 font-mono text-[10px] ${
                            s.status === 'pinned_unavailable'
                              ? 'border-[color-mix(in_oklab,var(--color-warn)_45%,var(--color-line))] bg-[color-mix(in_oklab,var(--color-warn)_9%,transparent)] text-[var(--color-warn)]'
                              : 'border-[var(--color-line-2)] bg-[var(--color-ink-850)] text-[var(--color-fg-muted)]'
                          }`}
                        >
                          {s.name}
                          <span className="text-[9px] text-[var(--color-fg-dim)]">
                            {s.policy === 'pinned' ? 'pinned' : 'flex'}
                          </span>
                        </span>
                      ))
                    ) : (
                      <span className="font-mono text-[10px] text-[var(--color-fg-dim)]">no workloads</span>
                    )}
                  </div>
                </div>
              )
            })}
            <GridFiller count={mapNodes.length} />
          </div>
        </Panel>

        {/* recent activity */}
        <Panel
          title="recent activity"
          right={
            <Link to="/events" className="font-mono text-[10px] normal-case text-[var(--color-fg-dim)] hover:text-[var(--color-fg-muted)]">
              all →
            </Link>
          }
        >
          {events.data?.events.length ? (
            <ul className="divide-y divide-[var(--color-line)]">
              {events.data.events.map((e, i) => (
                <li key={`${e.at}-${i}`} className="px-4 py-3">
                  <div className="flex items-center justify-between gap-3">
                    <span className="truncate font-mono text-[11.5px]">{e.service}</span>
                    <span
                      className={`shrink-0 font-mono text-[9.5px] uppercase tracking-[0.1em] ${
                        e.reason === 'failover' ? 'text-[var(--color-warn)]' : 'text-[var(--color-fg-dim)]'
                      }`}
                    >
                      {e.reason}
                    </span>
                  </div>
                  <div className="mt-1 font-mono text-[10.5px] text-[var(--color-fg-dim)]">
                    {e.from ? `${e.from} → ${e.to}` : `→ ${e.to}`} · {since(e.at)}
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="px-4 py-8 text-center font-mono text-[11px] text-[var(--color-fg-dim)]">
              nothing has happened yet
            </p>
          )}
        </Panel>
      </div>
    </div>
  )
}

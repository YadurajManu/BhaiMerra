import { useMemo } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { api, type Node } from '../lib/api'
import { useAuth, usePoll } from '../lib/auth'
import { mb, since } from '../lib/format'
import { Dot, ErrorNote, Panel, StatusPill } from '../components/ui'
import TimeSeriesChart, { type Marker } from '../components/TimeSeriesChart'
import { HeartbeatStrip, projectFull } from '../components/viz'
import { beatsFrom, type NodeSample } from '../lib/useSamples'

/**
 * Everything known about one machine.
 *
 * One range control drives every chart. Comparing CPU over six hours against
 * memory over one is a way to reach a confident wrong conclusion, so the
 * selector is deliberately not per-chart — and it lives in the URL, because
 * /nodes/:id?range=24h is a link worth sending someone mid-incident.
 */

const RANGES = [
  { key: '1h', label: '1h', minutes: 60 },
  { key: '2h', label: '2h', minutes: 120 },
  { key: '6h', label: '6h', minutes: 360 },
  { key: '12h', label: '12h', minutes: 720 },
  { key: '24h', label: '24h', minutes: 1440 },
  { key: '7d', label: '7d', minutes: 10080 },
  { key: '30d', label: '30d', minutes: 43200 },
] as const

type Peaks = {
  cpuMax: number | null; cpuAvg: number | null
  ramMaxMb: number | null; ramAvgMb: number | null
  netRxMax: number | null; netTxMax: number | null
  tempMax: number | null; load1Max: number | null
  samples: number; coverage: number | null
}
type SamplesResponse = { grain: string; sinceMinutes: number; peaks: Peaks; samples: NodeSample[] }
type NodeEvent = { at: string; kind: string; label: string; tone: 'info' | 'warn' | 'down' }

const SERIES = { cpu: '#3987e5', ram: '#9a6bd8', disk: '#12a594', netRx: '#d6409f', netTx: '#a16207' }

function Tile({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: string }) {
  return (
    <div className="bg-[var(--color-ink-950)] p-4">
      <div className="mono-label text-[9px] text-[var(--color-fg-dim)]">{label}</div>
      <div
        className="mt-1.5 text-[19px] font-semibold tabular-nums tracking-[-0.02em]"
        style={{ color: tone ?? 'var(--color-fg)' }}
      >
        {value}
      </div>
      {sub && <div className="mt-0.5 font-mono text-[10.5px] text-[var(--color-fg-muted)]">{sub}</div>}
    </div>
  )
}

export default function NodeDetail() {
  const { nodeId } = useParams<{ nodeId: string }>()
  const { fleet } = useAuth()
  const [params, setParams] = useSearchParams()

  const rangeKey = params.get('range') ?? '6h'
  const range = RANGES.find((r) => r.key === rangeKey) ?? RANGES[2]

  const nodes = usePoll(
    () => (fleet?.id ? api<{ nodes: Node[] }>(`/fleets/${fleet.id}/nodes`) : Promise.resolve({ nodes: [] })),
    [fleet?.id],
    10_000
  )
  const node = nodes.data?.nodes.find((n) => n.id === nodeId)

  // History refreshes far more slowly than the node list. The list answers "is
  // it alive", which must be current; a chart's left edge has not moved.
  const hist = usePoll(
    () =>
      fleet?.id && nodeId
        ? api<SamplesResponse>(`/fleets/${fleet.id}/nodes/${nodeId}/samples?since=${range.minutes}`)
        : Promise.resolve(null as unknown as SamplesResponse),
    [fleet?.id, nodeId, range.minutes],
    60_000
  )

  const evts = usePoll(
    () =>
      fleet?.id && nodeId
        ? api<{ events: NodeEvent[] }>(`/fleets/${fleet.id}/nodes/${nodeId}/events?since=${range.minutes}`)
        : Promise.resolve({ events: [] }),
    [fleet?.id, nodeId, range.minutes],
    60_000
  )

  const samples = hist.data?.samples ?? []
  const peaks = hist.data?.peaks
  const t = node?.telemetry

  const markers: Marker[] = useMemo(
    () => (evts.data?.events ?? []).map((e) => ({ at: +new Date(e.at), label: e.label, tone: e.tone })),
    [evts.data]
  )

  const pt = (pick: (s: NodeSample) => number | null | undefined) =>
    samples.map((s) => ({ t: +new Date(s.at), v: pick(s) ?? null }))

  const diskTotal =
    t?.diskTotalMb ?? (t?.diskUsedMb != null && node?.diskMb ? t.diskUsedMb + node.diskMb : 0)

  const projection = useMemo(() => {
    const d = samples.filter((s) => s.diskUsedMb != null).map((s) => ({ t: +new Date(s.at), used: s.diskUsedMb! }))
    return diskTotal ? projectFull(d, diskTotal) : null
  }, [samples, diskTotal])

  const beats = useMemo(() => beatsFrom(samples, 60, range.minutes * 60_000), [samples, range.minutes])
  const recorded = beats.filter((b) => b !== 'nodata')
  const uptime = recorded.length ? (recorded.filter((b) => b === 'ok').length / recorded.length) * 100 : null

  /* Only true when a node has actually reported one. An agent too old to send
     network or temperature should show nothing, not a confident zero. */
  const hasNet = samples.some((s) => s.netRxKbps != null || s.netTxKbps != null)
  const hasTemp = samples.some((s) => s.tempC != null)
  const hasLoad = samples.some((s) => s.load1 != null)

  if (nodes.error) return <ErrorNote error={nodes.error} />
  if (!node) {
    return (
      <div className="space-y-4">
        <Link to="/nodes" className="font-mono text-[11.5px] text-[var(--color-fg-dim)] hover:text-[var(--color-fg)]">
          ← nodes
        </Link>
        <p className="font-mono text-[12px] text-[var(--color-fg-dim)]">
          {nodes.data ? 'That node is not in this fleet.' : 'Loading…'}
        </p>
      </div>
    )
  }

  const staleWarning =
    peaks && peaks.coverage != null && peaks.coverage < 0.5 && peaks.samples > 0

  return (
    <div className="space-y-5">
      {/* header */}
      <div>
        <Link to="/nodes" className="font-mono text-[11.5px] text-[var(--color-fg-dim)] transition-colors hover:text-[var(--color-fg)]">
          ← nodes
        </Link>
        <div className="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-2">
          <h1 className="text-[24px] font-semibold tracking-[-0.03em]">{node.name}</h1>
          <StatusPill status={node.status} />
          <span className="font-mono text-[11.5px] text-[var(--color-fg-dim)]">
            {node.os} ({node.arch}) · {node.cpuCores} cores · {mb(node.ramMb)} RAM
          </span>
          <span className="ml-auto flex items-center gap-2 font-mono text-[11px] text-[var(--color-fg-dim)]">
            <Dot tone={node.status === 'online' ? 'ok' : 'down'} size={6} />
            {since(node.lastHeartbeatAt)}
          </span>
        </div>
      </div>

      {/* one range control for every chart on the page */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="mono-label text-[9px] text-[var(--color-fg-dim)]">RANGE</span>
        {RANGES.map((r) => (
          <button
            key={r.key}
            onClick={() => setParams({ range: r.key }, { replace: true })}
            aria-pressed={r.key === range.key}
            className={`px-2.5 py-1 font-mono text-[11px] transition-colors duration-200 ${
              r.key === range.key
                ? 'bg-[var(--color-signal)] text-[#04140c]'
                : 'border border-[var(--color-line-2)] text-[var(--color-fg-dim)] hover:text-[var(--color-fg)]'
            }`}
          >
            {r.label}
          </button>
        ))}
        {hist.data && (
          <span className="ml-auto font-mono text-[10px] text-[var(--color-fg-dim)]">
            {hist.data.grain} grain · {samples.length} points
          </span>
        )}
      </div>

      {staleWarning && (
        <p className="border-l-2 border-[var(--color-warn)] py-2 pl-3 font-mono text-[11px] text-[var(--color-fg-muted)]">
          Only {Math.round((peaks!.coverage ?? 0) * 100)}% of this window has data — the node was
          not reporting for most of it, so these figures describe part of the period, not all of it.
        </p>
      )}

      {/* the summary before the detail */}
      <div className="grid gap-px bg-[var(--color-line)] sm:grid-cols-2 lg:grid-cols-4">
        <Tile
          label={`cpu peak · ${range.label}`}
          value={peaks?.cpuMax != null ? `${Math.round(peaks.cpuMax)}%` : '—'}
          sub={peaks?.cpuAvg != null ? `avg ${Math.round(peaks.cpuAvg)}%` : undefined}
          tone={peaks?.cpuMax != null && peaks.cpuMax > 85 ? 'var(--color-warn)' : undefined}
        />
        <Tile
          label={`memory peak · ${range.label}`}
          value={peaks?.ramMaxMb != null ? mb(peaks.ramMaxMb) : '—'}
          sub={`of ${mb(node.ramMb)}`}
          tone={peaks?.ramMaxMb != null && peaks.ramMaxMb / node.ramMb > 0.9 ? 'var(--color-warn)' : undefined}
        />
        <Tile
          label="disk"
          value={t?.diskUsedMb != null ? mb(t.diskUsedMb) : '—'}
          sub={projection ? `full in ${Math.round(projection.days)} days` : diskTotal ? `of ${mb(diskTotal)}` : undefined}
          tone={projection && projection.days < 14 ? 'var(--color-warn)' : undefined}
        />
        <Tile
          label={`uptime · ${range.label}`}
          value={uptime != null ? `${uptime.toFixed(1)}%` : '—'}
          sub={recorded.length ? `${recorded.filter((b) => b === 'missed').length} gaps` : 'no history yet'}
          tone={uptime != null && uptime < 99 ? 'var(--color-warn)' : undefined}
        />
      </div>

      {/* charts, all on the same time axis */}
      <Panel title={`cpu · ${range.label}`} right={<span className="normal-case">band is min to max, line is the mean</span>}>
        <div className="p-4">
          <TimeSeriesChart
            ceiling={100}
            unit="%"
            markers={markers}
            format={(v) => `${Math.round(v)}%`}
            emptyHint="No CPU history in this window yet. It fills in as the node reports."
            series={[{
              label: 'cpu', colour: SERIES.cpu,
              avg: pt((s) => s.cpuPct),
              min: pt((s) => s.cpuMin ?? s.cpuPct),
              max: pt((s) => s.cpuMax ?? s.cpuPct),
            }]}
          />
        </div>
      </Panel>

      <Panel title={`memory · ${range.label}`}>
        <div className="p-4">
          <TimeSeriesChart
            ceiling={node.ramMb}
            markers={markers}
            format={(v) => mb(v)}
            emptyHint="No memory history in this window yet."
            series={[{
              label: 'memory', colour: SERIES.ram,
              avg: pt((s) => s.ramUsedMb),
              min: pt((s) => s.ramUsedMb),
              max: pt((s) => s.ramMaxMb ?? s.ramUsedMb),
            }]}
          />
        </div>
      </Panel>

      <Panel
        title={`network · ${range.label}`}
        right={!hasNet ? <span className="normal-case text-[var(--color-warn)]">agent upgrade required</span> : undefined}
      >
        <div className="p-4">
          {hasNet ? (
            <TimeSeriesChart
              markers={markers}
              unit=" kB/s"
              format={(v) => (v >= 1024 ? `${(v / 1024).toFixed(1)}M` : String(Math.round(v)))}
              series={[
                { label: 'in', colour: SERIES.netRx, avg: pt((s) => s.netRxKbps) },
                { label: 'out', colour: SERIES.netTx, avg: pt((s) => s.netTxKbps) },
              ]}
            />
          ) : (
            <p className="py-8 text-center font-mono text-[11px] leading-relaxed text-[var(--color-fg-dim)]">
              This node runs agent {node.agentVersion ?? 'v0.1.9'}, which does not report network.
              <br />
              Re-run the installer on it to start collecting.
            </p>
          )}
        </div>
      </Panel>

      {(hasLoad || hasTemp) && (
        <Panel title={`load and temperature · ${range.label}`}>
          <div className="p-4">
            <TimeSeriesChart
              markers={markers}
              format={(v) => v.toFixed(1)}
              series={[
                ...(hasLoad ? [{ label: 'load', colour: SERIES.disk, avg: pt((s) => s.load1) }] : []),
                ...(hasTemp ? [{ label: '°C', colour: SERIES.netTx, avg: pt((s) => s.tempC) }] : []),
              ]}
            />
          </div>
        </Panel>
      )}

      {/* reporting history */}
      <Panel title={`reporting · ${range.label}`}>
        <div className="flex items-center gap-3 p-4">
          <HeartbeatStrip beats={beats} height={20} />
          <span className="shrink-0 font-mono text-[10.5px] tabular-nums text-[var(--color-fg-dim)]">
            {recorded.length ? `${recorded.filter((b) => b === 'ok').length}/${recorded.length}` : 'no history'}
          </span>
        </div>
      </Panel>

      {/* context */}
      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="what the scheduler sees">
          <dl className="divide-y divide-[var(--color-line)]">
            {[
              ['architecture', node.arch],
              ['cores', String(node.cpuCores)],
              ['memory', mb(node.ramMb)],
              ['free disk', mb(node.diskMb)],
              ['gpu', node.hasGpu ? 'yes' : 'no'],
              ['reliability', node.reliabilityTier],
              ['tags', node.tags.length ? node.tags.join(', ') : '—'],
              ['agent', node.agentVersion ?? '—'],
            ].map(([k, v]) => (
              <div key={k} className="flex items-center justify-between gap-4 px-5 py-2.5">
                <dt className="mono-label text-[10px] text-[var(--color-fg-dim)]">{k}</dt>
                <dd className="truncate font-mono text-[12px] text-[var(--color-fg-muted)]">{v}</dd>
              </div>
            ))}
          </dl>
        </Panel>

        <Panel title={`what happened · ${range.label}`}>
          {(evts.data?.events ?? []).length ? (
            <div className="max-h-[280px] divide-y divide-[var(--color-line)] overflow-y-auto">
              {evts.data!.events.map((e, i) => (
                <div key={i} className="flex items-baseline gap-3 px-5 py-2.5">
                  <span className="min-w-[74px] shrink-0 font-mono text-[10.5px] text-[var(--color-fg-dim)]">
                    {since(e.at)}
                  </span>
                  <span
                    className="font-mono text-[11.5px]"
                    style={{ color: e.tone === 'down' ? 'var(--color-down)' : e.tone === 'warn' ? 'var(--color-warn)' : 'var(--color-fg-muted)' }}
                  >
                    {e.label}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <p className="px-5 py-8 text-center font-mono text-[11px] text-[var(--color-fg-dim)]">
              nothing deployed or moved here in this window
            </p>
          )}
        </Panel>
      </div>
    </div>
  )
}

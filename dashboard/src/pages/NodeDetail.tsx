import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { api, type Node } from '../lib/api'
import { useAuth, usePoll } from '../lib/auth'
import { mb, since } from '../lib/format'
import { Dot, ErrorNote, Panel, StatusPill } from '../components/ui'
import TimeSeriesChart, { type ChartSeries, type Marker } from '../components/TimeSeriesChart'
import { HeartbeatStrip, projectFull } from '../components/viz'
import { beatsFrom, dockerBeatsFrom, type NodeSample } from '../lib/useSamples'

/**
 * Everything known about one machine.
 *
 * One range control drives every chart. Comparing CPU over six hours against
 * memory over one is a way to reach a confident wrong conclusion, so the
 * selector is deliberately not per-chart — and it lives in the URL, because
 * /nodes/:id?range=24h is a link worth sending someone mid-incident.
 *
 * The crosshair is shared for the same reason. Four charts on a shared axis
 * exist so you can ask "what was memory doing when CPU spiked", and answering
 * that by eye across four panels is guesswork. Hovering anywhere reads every
 * metric at that instant.
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

const toneColour = (tone: string) =>
  tone === 'down' ? 'var(--color-down)' : tone === 'warn' ? 'var(--color-warn)' : 'var(--color-fg-muted)'

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

/** One chart's identity, so the expanded view can cycle between them. */
type ChartDef = {
  key: string
  title: string
  note?: ReactNode
  series: ChartSeries[]
  ceiling?: number
  unit?: string
  format?: (v: number) => string
  emptyHint?: string
}

export default function NodeDetail() {
  const { nodeId } = useParams<{ nodeId: string }>()
  const { fleet } = useAuth()
  const [params, setParams] = useSearchParams()

  const rangeKey = params.get('range') ?? '6h'
  const range = RANGES.find((r) => r.key === rangeKey) ?? RANGES[2]

  /* Shared across every chart on the page. */
  const [hoverT, setHoverT] = useState<number | null>(null)
  const [zoom, setZoom] = useState<{ from: number; to: number } | null>(null)
  const [expanded, setExpanded] = useState<string | null>(null)

  // A zoom is a window inside a range. Changing the range makes it meaningless,
  // and keeping it would silently show a slice of a period the reader thinks
  // they are seeing in full.
  useEffect(() => setZoom(null), [range.key])

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

  const allSamples = hist.data?.samples ?? []
  const t = node?.telemetry

  const samples = useMemo(() => {
    if (!zoom) return allSamples
    return allSamples.filter((s) => {
      const ts = +new Date(s.at)
      return ts >= zoom.from && ts <= zoom.to
    })
  }, [allSamples, zoom])

  /* Zooming has to move the summary too. Tiles that still describe the whole
     range while the charts show ten minutes of it is a mismatch nobody reads
     carefully enough to catch. */
  const peaks: Peaks | undefined = useMemo(() => {
    if (!zoom) return hist.data?.peaks
    const num = (pick: (s: NodeSample) => number | null | undefined) =>
      samples.map(pick).filter((v): v is number => v != null)
    const max = (xs: number[]) => (xs.length ? Math.max(...xs) : null)
    const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null)
    const cpu = num((s) => s.cpuPct)
    const ram = num((s) => s.ramUsedMb)
    return {
      cpuMax: max(num((s) => s.cpuMax ?? s.cpuPct)), cpuAvg: avg(cpu),
      ramMaxMb: max(num((s) => s.ramMaxMb ?? s.ramUsedMb)), ramAvgMb: avg(ram),
      netRxMax: max(num((s) => s.netRxKbps)), netTxMax: max(num((s) => s.netTxKbps)),
      tempMax: max(num((s) => s.tempC)), load1Max: max(num((s) => s.load1)),
      samples: samples.length, coverage: null,
    }
  }, [zoom, hist.data, samples])

  const events = evts.data?.events ?? []
  const markers: Marker[] = useMemo(
    () => events.map((e) => ({ at: +new Date(e.at), label: e.label, tone: e.tone })),
    [events]
  )

  const pt = useCallback(
    (pick: (s: NodeSample) => number | null | undefined) =>
      samples.map((s) => ({ t: +new Date(s.at), v: pick(s) ?? null })),
    [samples]
  )

  const diskTotal =
    t?.diskTotalMb ?? (t?.diskUsedMb != null && node?.diskMb ? t.diskUsedMb + node.diskMb : 0)

  const projection = useMemo(() => {
    const d = samples.filter((s) => s.diskUsedMb != null).map((s) => ({ t: +new Date(s.at), used: s.diskUsedMb! }))
    return diskTotal ? projectFull(d, diskTotal) : null
  }, [samples, diskTotal])

  // Zooming narrows the window the strip describes too. Left at the full range
  // it would draw a zoomed selection as a short run of beats followed by hours
  // of "no data", which reads as an outage rather than as a chosen window.
  const beatWindowMs = zoom ? Math.max(zoom.to - zoom.from, 60_000) : range.minutes * 60_000
  const beats = useMemo(() => beatsFrom(samples, 60, beatWindowMs), [samples, beatWindowMs])
  const recorded = beats.filter((b) => b !== 'nodata')
  const dockerBeats = useMemo(() => dockerBeatsFrom(samples, 60, beatWindowMs), [samples, beatWindowMs])
  const dockerRecorded = dockerBeats.filter((b) => b !== 'nodata')
  const uptime = recorded.length ? (recorded.filter((b) => b === 'ok').length / recorded.length) * 100 : null

  /* Only true when a node has actually reported one. An agent too old to send
     network or temperature should show nothing, not a confident zero. */
  const hasNet = samples.some((s) => s.netRxKbps != null || s.netTxKbps != null)
  const hasTemp = samples.some((s) => s.tempC != null)
  const hasLoad = samples.some((s) => s.load1 != null)
  const hasDisk = samples.some((s) => s.diskUsedMb != null)
  const hasSwap = samples.some((s) => s.swapUsedMb != null)
  const hasContainers = samples.some((s) => s.containers != null)
  const hasDocker = samples.some((s) => s.dockerOk != null)

  /* Which metrics this agent never sends, named once rather than as a grid of
     empty boxes. Four charts beside three "agent upgrade required" panels
     looks like something is broken; a single line saying what is missing and
     how to get it does not. */
  const missing = [
    !hasNet && 'network',
    !hasSwap && 'swap',
    !hasTemp && 'temperature',
    !hasLoad && 'load',
  ].filter(Boolean) as string[]

  const diskCeiling = samples.reduce((m, s) => Math.max(m, s.diskTotalMb ?? 0), 0) || diskTotal

  const charts: ChartDef[] = useMemo(() => {
    if (!node) return []
    const list: ChartDef[] = [
      {
        key: 'cpu',
        title: 'cpu',
        note: 'band is min to max, line is the mean',
        ceiling: 100,
        // No `unit` here: the tooltip appends unit to the formatted value, and
        // this formatter already carries the sign. Setting both printed "52%%".
        format: (v) => `${Math.round(v)}%`,
        emptyHint: 'No CPU history in this window yet. It fills in as the node reports.',
        series: [{
          label: 'cpu', colour: SERIES.cpu,
          avg: pt((s) => s.cpuPct),
          min: pt((s) => s.cpuMin ?? s.cpuPct),
          max: pt((s) => s.cpuMax ?? s.cpuPct),
        }],
      },
      {
        key: 'memory',
        title: 'memory',
        ceiling: node.ramMb,
        format: (v) => mb(v),
        emptyHint: 'No memory history in this window yet.',
        series: [{
          label: 'memory', colour: SERIES.ram,
          avg: pt((s) => s.ramUsedMb),
          min: pt((s) => s.ramUsedMb),
          max: pt((s) => s.ramMaxMb ?? s.ramUsedMb),
        }],
      },
    ]
    if (hasNet) {
      list.push({
        key: 'network',
        title: 'network',
        unit: ' kB/s',
        format: (v) => (v >= 1024 ? `${(v / 1024).toFixed(1)}M` : String(Math.round(v))),
        series: [
          { label: 'in', colour: SERIES.netRx, avg: pt((s) => s.netRxKbps) },
          { label: 'out', colour: SERIES.netTx, avg: pt((s) => s.netTxKbps) },
        ],
      })
    }
    if (hasDisk) {
      list.push({
        key: 'disk',
        title: 'disk',
        // Capacity as the ceiling, so the line reads as a share of full rather
        // than a number that happens to be large. The card projects a date the
        // disk runs out; this is the evidence that projection comes from, and
        // it is the metric most likely to actually stop a node.
        ceiling: diskCeiling || undefined,
        format: (v) => mb(v),
        emptyHint: 'No disk history in this window yet.',
        series: [{ label: 'used', colour: SERIES.disk, avg: pt((s) => s.diskUsedMb) }],
      })
    }
    if (hasSwap) {
      list.push({
        key: 'swap',
        title: 'swap',
        note: 'rising swap is the warning before memory runs out',
        format: (v) => mb(v),
        series: [{ label: 'swap', colour: SERIES.netTx, avg: pt((s) => s.swapUsedMb) }],
      })
    }
    if (hasLoad || hasTemp) {
      list.push({
        key: 'load',
        title: 'load and temperature',
        format: (v) => v.toFixed(1),
        series: [
          ...(hasLoad ? [{ label: 'load', colour: SERIES.disk, avg: pt((s) => s.load1) }] : []),
          ...(hasTemp ? [{ label: '°C', colour: SERIES.netTx, avg: pt((s) => s.tempC) }] : []),
        ],
      })
    }
    if (hasContainers) {
      list.push({
        key: 'containers',
        title: 'containers',
        format: (v) => String(Math.round(v)),
        emptyHint: 'No container history in this window yet.',
        series: [{ label: 'running', colour: SERIES.ram, avg: pt((s) => s.containers) }],
      })
    }
    return list
  }, [node, pt, hasNet, hasLoad, hasTemp, hasDisk, hasSwap, hasContainers, diskCeiling])

  const expandedIndex = charts.findIndex((c) => c.key === expanded)
  const step = useCallback(
    (delta: number) => {
      if (!charts.length || expandedIndex < 0) return
      const next = (expandedIndex + delta + charts.length) % charts.length
      setExpanded(charts[next]!.key)
    },
    [charts, expandedIndex]
  )

  // Esc closes, arrows move between metrics without leaving the expanded view.
  useEffect(() => {
    if (!expanded) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setExpanded(null)
      else if (e.key === 'ArrowRight') { e.preventDefault(); step(1) }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); step(-1) }
    }
    window.addEventListener('keydown', onKey)
    // Nothing behind the overlay should scroll under it.
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      window.removeEventListener('keydown', onKey)
      document.body.style.overflow = prev
    }
  }, [expanded, step])

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

  const staleWarning = !zoom && peaks && peaks.coverage != null && peaks.coverage < 0.5 && peaks.samples > 0

  const shared = {
    hoverT,
    onHoverT: setHoverT,
    onZoom: (from: number, to: number) => setZoom({ from, to }),
    markers,
  }

  const windowLabel = zoom
    ? `${new Date(zoom.from).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}–${new Date(zoom.to).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
    : range.label

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
        {zoom && (
          <button
            onClick={() => setZoom(null)}
            className="flash-signal flex items-center gap-1.5 border border-[var(--color-signal)] px-2.5 py-1 font-mono text-[11px] text-[var(--color-signal)] transition-colors hover:bg-[var(--color-signal)] hover:text-[#04140c]"
          >
            ✕ zoomed {windowLabel} · back to {range.label}
          </button>
        )}
        {hist.data && (
          <span className="ml-auto font-mono text-[10px] text-[var(--color-fg-dim)]">
            {hist.data.grain} grain · {samples.length} points
            {charts.length > 0 && <span className="ml-2 opacity-70">drag to zoom</span>}
          </span>
        )}
      </div>

      {/* what changed, on the same axis the charts use */}
      {events.length > 0 && (
        <div className="flex items-center gap-2 overflow-x-auto pb-1">
          <span className="mono-label shrink-0 text-[9px] text-[var(--color-fg-dim)]">CHANGES</span>
          {events.slice(0, 12).map((e, i) => (
            <button
              key={i}
              onMouseEnter={() => setHoverT(+new Date(e.at))}
              onMouseLeave={() => setHoverT(null)}
              title={new Date(e.at).toLocaleString()}
              className="shrink-0 border-l-2 bg-[var(--color-ink-950)] py-1 pl-2 pr-3 text-left transition-colors hover:bg-[var(--color-ink-900)]"
              style={{ borderColor: toneColour(e.tone) }}
            >
              <span className="font-mono text-[10px] text-[var(--color-fg-dim)]">
                {new Date(e.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              </span>
              <span className="ml-2 font-mono text-[11px]" style={{ color: toneColour(e.tone) }}>
                {e.label}
              </span>
            </button>
          ))}
        </div>
      )}

      {staleWarning && (
        <p className="border-l-2 border-[var(--color-warn)] py-2 pl-3 font-mono text-[11px] text-[var(--color-fg-muted)]">
          Only {Math.round((peaks!.coverage ?? 0) * 100)}% of this window has data — the node was
          not reporting for most of it, so these figures describe part of the period, not all of it.
        </p>
      )}

      {/* the summary before the detail */}
      <div className="grid gap-px bg-[var(--color-line)] sm:grid-cols-2 lg:grid-cols-4">
        <Tile
          label={`cpu peak · ${windowLabel}`}
          value={peaks?.cpuMax != null ? `${Math.round(peaks.cpuMax)}%` : '—'}
          sub={peaks?.cpuAvg != null ? `avg ${Math.round(peaks.cpuAvg)}%` : undefined}
          tone={peaks?.cpuMax != null && peaks.cpuMax > 85 ? 'var(--color-warn)' : undefined}
        />
        <Tile
          label={`memory peak · ${windowLabel}`}
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
          label={`uptime · ${windowLabel}`}
          value={uptime != null ? `${uptime.toFixed(1)}%` : '—'}
          sub={recorded.length ? `${recorded.filter((b) => b === 'missed').length} gaps` : 'no history yet'}
          tone={uptime != null && uptime < 99 ? 'var(--color-warn)' : undefined}
        />
      </div>

      {/* Small multiples: every metric on one screen, on one time axis and one
          crosshair. Full width each, they were 9:1 boxes you had to scroll
          past one at a time; half width they read better AND fit together.
          The grid is the glance, and expanding is where a value gets read. */}
      <div className="grid gap-4 lg:grid-cols-2">
        {charts.map((c) => (
          <Panel
            key={c.key}
            title={`${c.title} · ${windowLabel}`}
            right={c.note ? <span className="normal-case">{c.note}</span> : undefined}
          >
            <div className="p-4">
              <TimeSeriesChart
                {...shared}
                height={170}
                series={c.series}
                ceiling={c.ceiling}
                unit={c.unit}
                format={c.format}
                emptyHint={c.emptyHint}
                onExpand={() => setExpanded(c.key)}
                expandLabel={`Expand ${c.title}`}
              />
            </div>
          </Panel>
        ))}
      </div>

      {missing.length > 0 && (
        <p className="border-l-2 border-[var(--color-line-2)] py-2 pl-3 font-mono text-[11px] leading-relaxed text-[var(--color-fg-dim)]">
          This node runs agent {node.agentVersion ? `v${node.agentVersion}` : 'an older build'}, which
          does not report {missing.join(', ')}. Re-run the installer with{' '}
          <span className="text-[var(--color-fg-muted)]">--reset</span> to start collecting{' '}
          {missing.length === 1 ? 'it' : 'them'}.
        </p>
      )}

      {/* reporting history */}
      <Panel title={`reporting · ${windowLabel}`}>
        <div className="space-y-2.5 p-4">
          <div className="flex items-center gap-3">
            <span className="mono-label w-[68px] shrink-0 text-[9px] text-[var(--color-fg-dim)]">
              HEARTBEAT
            </span>
            <HeartbeatStrip beats={beats} height={20} />
            <span className="shrink-0 font-mono text-[10.5px] tabular-nums text-[var(--color-fg-dim)]">
              {recorded.length ? `${recorded.filter((b) => b === 'ok').length}/${recorded.length}` : 'no history'}
            </span>
          </div>

          {/* Not a chart, because it is a yes or no. A node can report
              faithfully every five seconds with a dead Docker daemon, and the
              row above would be unbroken green - the state where nothing can
              be deployed and everything looks fine. */}
          {hasDocker && (
            <div className="flex items-center gap-3">
              <span className="mono-label w-[68px] shrink-0 text-[9px] text-[var(--color-fg-dim)]">
                DOCKER
              </span>
              <HeartbeatStrip beats={dockerBeats} height={20} label="Docker daemon reachability" />
              <span className="shrink-0 font-mono text-[10.5px] tabular-nums text-[var(--color-fg-dim)]">
                {dockerRecorded.length
                  ? `${dockerRecorded.filter((b) => b === 'ok').length}/${dockerRecorded.length}`
                  : 'no history'}
              </span>
            </div>
          )}
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
          {events.length ? (
            <div className="max-h-[280px] divide-y divide-[var(--color-line)] overflow-y-auto">
              {events.map((e, i) => (
                <div key={i} className="flex items-baseline gap-3 px-5 py-2.5">
                  <span className="min-w-[74px] shrink-0 font-mono text-[10.5px] text-[var(--color-fg-dim)]">
                    {since(e.at)}
                  </span>
                  <span className="font-mono text-[11.5px]" style={{ color: toneColour(e.tone) }}>
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

      {expandedIndex >= 0 && (
        <ExpandedChart
          chart={charts[expandedIndex]!}
          index={expandedIndex}
          total={charts.length}
          windowLabel={windowLabel}
          shared={shared}
          onClose={() => setExpanded(null)}
          onStep={step}
        />
      )}
    </div>
  )
}

/**
 * The same chart, given the room to be read.
 *
 * Stacked four to a page a chart is about 150px tall against 1400 wide — nearly
 * all horizontal, so a four percent wobble and a forty percent one look alike.
 * Here it gets most of the viewport, which is the only thing that actually
 * fixes that.
 */
function ExpandedChart({
  chart, index, total, windowLabel, shared, onClose, onStep,
}: {
  chart: ChartDef
  index: number
  total: number
  windowLabel: string
  shared: {
    hoverT: number | null
    onHoverT: (t: number | null) => void
    onZoom: (from: number, to: number) => void
    markers: Marker[]
  }
  onClose: () => void
  onStep: (delta: number) => void
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm sm:p-8"
      style={{ animation: 'fade-up 0.2s var(--ease-out-expo) both' }}
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={`${chart.title} expanded`}
    >
      <div
        // Clicking the backdrop closes; clicking the chart must not.
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-[1200px] border border-[var(--color-line-2)] bg-[var(--color-ink-950)] shadow-2xl"
        style={{ animation: 'rise-in 0.28s var(--ease-out-expo) both' }}
      >
        <div className="flex items-center gap-3 border-b border-[var(--color-line)] px-5 py-3">
          <h2 className="mono-label text-[11px] text-[var(--color-fg)]">
            {chart.title} · {windowLabel}
          </h2>
          {chart.note && (
            <span className="hidden font-mono text-[10.5px] text-[var(--color-fg-dim)] sm:inline">
              {chart.note}
            </span>
          )}

          <div className="ml-auto flex items-center gap-1">
            <button
              onClick={() => onStep(-1)}
              aria-label="Previous metric"
              className="flex h-7 w-7 items-center justify-center border border-[var(--color-line-2)] font-mono text-[12px] text-[var(--color-fg-dim)] transition-colors hover:border-[var(--color-signal)] hover:text-[var(--color-signal)]"
            >
              ←
            </button>
            <span className="px-1 font-mono text-[10.5px] tabular-nums text-[var(--color-fg-dim)]">
              {index + 1}/{total}
            </span>
            <button
              onClick={() => onStep(1)}
              aria-label="Next metric"
              className="flex h-7 w-7 items-center justify-center border border-[var(--color-line-2)] font-mono text-[12px] text-[var(--color-fg-dim)] transition-colors hover:border-[var(--color-signal)] hover:text-[var(--color-signal)]"
            >
              →
            </button>
            <button
              onClick={onClose}
              aria-label="Close"
              className="ml-2 flex h-7 w-7 items-center justify-center border border-[var(--color-line-2)] font-mono text-[12px] text-[var(--color-fg-dim)] transition-colors hover:border-[var(--color-down)] hover:text-[var(--color-down)]"
            >
              ✕
            </button>
          </div>
        </div>

        <div className="p-5">
          {/* Keyed on the metric so switching re-runs the entrance animation
              rather than swapping the paths under a static frame. */}
          <div key={chart.key} style={{ animation: 'fade-up 0.24s var(--ease-out-expo) both' }}>
            <TimeSeriesChart
              {...shared}
              height={Math.max(320, Math.round(window.innerHeight * 0.62))}
              series={chart.series}
              ceiling={chart.ceiling}
              unit={chart.unit}
              format={chart.format}
              emptyHint={chart.emptyHint}
            />
          </div>
        </div>

        <div className="border-t border-[var(--color-line)] px-5 py-2.5 font-mono text-[10px] text-[var(--color-fg-dim)]">
          drag to zoom · ← → to change metric · esc to close
        </div>
      </div>
    </div>
  )
}

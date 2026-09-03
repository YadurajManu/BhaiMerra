import { useId, useMemo, useRef, useState } from 'react'

/**
 * One metric over time, drawn to a single scale.
 *
 * The band between minimum and maximum is the point of this chart. An averaged
 * line says a node sat at 31% all afternoon; the band says it touched 94% once,
 * and that is the difference between a decoration and a diagnosis. Where a
 * series has no min/max — anything older than the columns that store them — the
 * band is simply absent and the mean is drawn alone, rather than faking a range.
 */

export type Marker = {
  at: number
  label: string
  tone?: 'info' | 'warn' | 'down'
}

export type ChartSeries = {
  /** Mean, or the only value where a metric has no spread. */
  avg: Array<{ t: number; v: number | null }>
  /** Optional envelope. Same timestamps as avg. */
  min?: Array<{ t: number; v: number | null }>
  max?: Array<{ t: number; v: number | null }>
  colour: string
  label: string
}

const TONE: Record<string, string> = {
  info: 'var(--color-fg-dim)',
  warn: 'var(--color-warn)',
  down: 'var(--color-down)',
}

const PAD = { l: 46, r: 12, t: 10, b: 22 }

export default function TimeSeriesChart({
  series,
  height = 150,
  unit = '',
  ceiling,
  format = (v: number) => String(Math.round(v)),
  markers = [],
  emptyHint = 'No history in this window yet.',
}: {
  series: ChartSeries[]
  height?: number
  unit?: string
  /** Fixed top of the scale. Without one a flat 3% line looks like a flat 90% one. */
  ceiling?: number
  format?: (v: number) => string
  markers?: Marker[]
  emptyHint?: string
}) {
  const id = useId()
  const svgRef = useRef<SVGSVGElement>(null)
  const [hoverX, setHoverX] = useState<number | null>(null)

  const model = useMemo(() => {
    const pts = series.flatMap((s) => s.avg)
    const withValue = pts.filter((p) => p.v != null)
    if (withValue.length < 2) return null

    const ts = pts.map((p) => p.t)
    const t0 = Math.min(...ts)
    const t1 = Math.max(...ts)

    const all = series.flatMap((s) => [
      ...s.avg.map((p) => p.v),
      ...(s.max ?? []).map((p) => p.v),
    ])
    const peak = ceiling ?? Math.max(...all.filter((v): v is number => v != null), 1)

    return { t0, t1: t1 === t0 ? t0 + 1 : t1, peak: peak || 1 }
  }, [series, ceiling])

  if (!model) {
    return (
      <div
        className="flex items-center justify-center rounded-[3px] border border-dashed border-[var(--color-line)] px-4 text-center font-mono text-[11px] leading-relaxed text-[var(--color-fg-dim)]"
        style={{ height }}
      >
        {emptyHint}
      </div>
    )
  }

  const W = 720
  const innerW = W - PAD.l - PAD.r
  const innerH = height - PAD.t - PAD.b
  const x = (t: number) => PAD.l + ((t - model.t0) / (model.t1 - model.t0)) * innerW
  const y = (v: number) => PAD.t + innerH - (v / model.peak) * innerH

  const line = (pts: Array<{ t: number; v: number | null }>) => {
    let d = ''
    let pen = false
    for (const p of pts) {
      if (p.v == null) {
        pen = false // a gap in the data is a gap in the line, not a straight leap across it
        continue
      }
      d += `${pen ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`
      pen = true
    }
    return d
  }

  const band = (s: ChartSeries) => {
    if (!s.min || !s.max) return null
    const top = s.max.filter((p) => p.v != null)
    const bottom = s.min.filter((p) => p.v != null)
    if (top.length < 2 || bottom.length < 2) return null
    const up = top.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(p.t).toFixed(1)},${y(p.v!).toFixed(1)}`).join('')
    const down = [...bottom].reverse().map((p) => `L${x(p.t).toFixed(1)},${y(p.v!).toFixed(1)}`).join('')
    return `${up}${down}Z`
  }

  // Four gridlines, each labelled with a value the chart actually reaches.
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => model.peak * f)

  const hoverT = hoverX == null ? null : model.t0 + ((hoverX - PAD.l) / innerW) * (model.t1 - model.t0)
  const readAt = (s: ChartSeries) => {
    if (hoverT == null) return null
    let best: { t: number; v: number | null } | null = null
    for (const p of s.avg) {
      if (!best || Math.abs(p.t - hoverT) < Math.abs(best.t - hoverT)) best = p
    }
    return best?.v ?? null
  }

  const span = model.t1 - model.t0
  const timeLabel = (t: number) =>
    span > 3 * 86_400_000
      ? new Date(t).toLocaleDateString([], { day: 'numeric', month: 'short' })
      : new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

  return (
    <div className="relative">
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${height}`}
        className="w-full touch-none"
        style={{ height }}
        role="img"
        aria-label={`${series.map((s) => s.label).join(' and ')} over time`}
        onMouseLeave={() => setHoverX(null)}
        onMouseMove={(e) => {
          const r = e.currentTarget.getBoundingClientRect()
          const px = ((e.clientX - r.left) / r.width) * W
          setHoverX(px < PAD.l || px > W - PAD.r ? null : px)
        }}
      >
        <defs>
          {series.map((s, i) => (
            <linearGradient key={i} id={`g-${id}-${i}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={s.colour} stopOpacity="0.26" />
              <stop offset="100%" stopColor={s.colour} stopOpacity="0.02" />
            </linearGradient>
          ))}
        </defs>

        {ticks.map((v, i) => (
          <g key={i}>
            <line
              x1={PAD.l} x2={W - PAD.r} y1={y(v)} y2={y(v)}
              stroke="var(--color-line)" strokeWidth="1" vectorEffect="non-scaling-stroke"
            />
            <text
              x={PAD.l - 7} y={y(v) + 3.5} textAnchor="end"
              fill="var(--color-fg-dim)" fontSize="10" fontFamily="ui-monospace, monospace"
            >
              {format(v)}
            </text>
          </g>
        ))}

        {/* Events on the same axis are what turn a spike into an explanation. */}
        {markers.map((m, i) => {
          const mx = x(m.at)
          if (mx < PAD.l || mx > W - PAD.r) return null
          return (
            <line
              key={i} x1={mx} x2={mx} y1={PAD.t} y2={PAD.t + innerH}
              stroke={TONE[m.tone ?? 'info']} strokeWidth="1" strokeDasharray="3 3"
              vectorEffect="non-scaling-stroke" opacity="0.75"
            >
              <title>{`${m.label} · ${timeLabel(m.at)}`}</title>
            </line>
          )
        })}

        {series.map((s, i) => {
          const b = band(s)
          return (
            <g key={i}>
              {b && <path d={b} fill={s.colour} fillOpacity="0.15" />}
              <path d={line(s.avg)} fill="none" stroke={s.colour} strokeWidth="1.8"
                    strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
            </g>
          )
        })}

        {hoverX != null && (
          <line
            x1={hoverX} x2={hoverX} y1={PAD.t} y2={PAD.t + innerH}
            stroke="var(--color-fg-muted)" strokeWidth="1" vectorEffect="non-scaling-stroke"
          />
        )}

        <text x={PAD.l} y={height - 6} fill="var(--color-fg-dim)" fontSize="10" fontFamily="ui-monospace, monospace">
          {timeLabel(model.t0)}
        </text>
        <text x={W - PAD.r} y={height - 6} textAnchor="end" fill="var(--color-fg-dim)" fontSize="10" fontFamily="ui-monospace, monospace">
          {timeLabel(model.t1)}
        </text>
      </svg>

      {hoverT != null && (
        <div
          className="pointer-events-none absolute top-1 z-10 whitespace-nowrap border border-[var(--color-line)] bg-[var(--color-ink-950)] px-2.5 py-1.5 shadow-lg"
          style={{
            // Flip to the left of the cursor past halfway so the tooltip never
            // runs off the right edge of the chart.
            left: hoverX! / W > 0.6 ? undefined : `${(hoverX! / W) * 100}%`,
            right: hoverX! / W > 0.6 ? `${100 - (hoverX! / W) * 100}%` : undefined,
          }}
        >
          <div className="font-mono text-[9.5px] uppercase tracking-[0.1em] text-[var(--color-fg-dim)]">
            {timeLabel(hoverT)}
          </div>
          {series.map((s) => {
            const v = readAt(s)
            return (
              <div key={s.label} className="mt-1 flex items-center gap-2 font-mono text-[11px]">
                <span className="h-2 w-2 shrink-0 rounded-[1px]" style={{ background: s.colour }} />
                <span className="text-[var(--color-fg-muted)]">{s.label}</span>
                <span className="ml-auto tabular-nums text-[var(--color-fg)]">
                  {v == null ? '—' : `${format(v)}${unit}`}
                </span>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

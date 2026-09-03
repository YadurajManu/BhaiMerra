import { useId, useMemo, useRef, useState } from 'react'

/**
 * One metric over time, drawn to a single scale.
 *
 * The band between minimum and maximum is the point of this chart. An averaged
 * line says a node sat at 31% all afternoon; the band says it touched 94% once,
 * and that is the difference between a decoration and a diagnosis. Where a
 * series has no min/max — anything older than the columns that store them — the
 * band is simply absent and the mean is drawn alone, rather than faking a range.
 *
 * Three things here exist to serve a page of several charts rather than one:
 *
 *   - the crosshair can be driven from outside, so hovering CPU at 03:14 reads
 *     memory and network at 03:14 too. Correlation is the whole reason to stack
 *     charts on a shared axis, and eyeballing vertical alignment across four
 *     panels is not correlation.
 *   - dragging selects a window and hands it up, so every chart zooms together.
 *   - expanding is a callback rather than internal state, because the expanded
 *     view belongs to the page that knows what the other metrics are.
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

/** Below this a drag is a click that wandered, not a selection. */
const DRAG_MIN_PX = 8

export default function TimeSeriesChart({
  series,
  height = 220,
  unit = '',
  ceiling,
  format = (v: number) => String(Math.round(v)),
  markers = [],
  emptyHint = 'No history in this window yet.',
  hoverT: hoverTProp,
  onHoverT,
  onZoom,
  onExpand,
  expandLabel = 'Expand this chart',
}: {
  series: ChartSeries[]
  height?: number
  unit?: string
  /** Fixed top of the scale. Without one a flat 3% line looks like a flat 90% one. */
  ceiling?: number
  format?: (v: number) => string
  markers?: Marker[]
  emptyHint?: string
  /** Crosshair position in ms, when the page is driving it. */
  hoverT?: number | null
  onHoverT?: (t: number | null) => void
  /** Called with the selected window when the reader drags across the plot. */
  onZoom?: (from: number, to: number) => void
  onExpand?: () => void
  expandLabel?: string
}) {
  const id = useId()
  const svgRef = useRef<SVGSVGElement>(null)
  // Used only when nothing outside is driving the crosshair, so the chart still
  // works on its own.
  const [localHoverT, setLocalHoverT] = useState<number | null>(null)
  const [drag, setDrag] = useState<{ from: number; to: number } | null>(null)

  const controlled = onHoverT != null
  const hoverT = controlled ? (hoverTProp ?? null) : localHoverT
  const setHoverT = (t: number | null) => (controlled ? onHoverT!(t) : setLocalHoverT(t))

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
  const tAt = (px: number) => model.t0 + ((px - PAD.l) / innerW) * (model.t1 - model.t0)

  /** Viewport pixels to the chart's own coordinate space. */
  const pxOf = (clientX: number, el: SVGSVGElement) => {
    const r = el.getBoundingClientRect()
    return ((clientX - r.left) / r.width) * W
  }

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

  // A crosshair driven from another chart can point outside this one's data.
  // Showing it clamped to the edge would claim a reading that does not exist.
  const hoverX =
    hoverT != null && hoverT >= model.t0 && hoverT <= model.t1 ? x(hoverT) : null

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

  const dragFrom = drag ? Math.min(drag.from, drag.to) : 0
  const dragTo = drag ? Math.max(drag.from, drag.to) : 0
  const dragging = drag != null && dragTo - dragFrom >= DRAG_MIN_PX

  const endDrag = () => {
    if (dragging && onZoom) onZoom(tAt(dragFrom), tAt(dragTo))
    setDrag(null)
  }

  return (
    <div className="group relative">
      {onExpand && (
        <button
          type="button"
          onClick={onExpand}
          aria-label={expandLabel}
          title={expandLabel}
          className="absolute right-1 top-1 z-20 flex h-7 w-7 items-center justify-center border border-[var(--color-line-2)] bg-[var(--color-ink-950)] text-[var(--color-fg-dim)] opacity-0 transition-all duration-200 hover:border-[var(--color-signal)] hover:text-[var(--color-signal)] focus-visible:opacity-100 group-hover:opacity-100"
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
            <path d="M4.5 1H1v3.5M7.5 11H11V7.5M11 4.5V1H7.5M1 7.5V11h3.5"
                  stroke="currentColor" strokeWidth="1.3" strokeLinecap="square" />
          </svg>
        </button>
      )}

      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${height}`}
        className={`w-full touch-none ${onZoom ? 'cursor-crosshair' : ''}`}
        style={{ height }}
        role="img"
        aria-label={`${series.map((s) => s.label).join(' and ')} over time`}
        onMouseLeave={() => {
          setHoverT(null)
          setDrag(null)
        }}
        onMouseDown={(e) => {
          if (!onZoom) return
          const px = pxOf(e.clientX, e.currentTarget)
          if (px < PAD.l || px > W - PAD.r) return
          setDrag({ from: px, to: px })
        }}
        onMouseMove={(e) => {
          const px = pxOf(e.clientX, e.currentTarget)
          setHoverT(px < PAD.l || px > W - PAD.r ? null : tAt(px))
          if (drag) setDrag({ ...drag, to: Math.min(Math.max(px, PAD.l), W - PAD.r) })
        }}
        onMouseUp={endDrag}
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

        {/* the window being selected, drawn under the crosshair */}
        {dragging && (
          <g>
            <rect
              x={dragFrom} y={PAD.t} width={dragTo - dragFrom} height={innerH}
              fill="var(--color-signal)" fillOpacity="0.12"
            />
            {[dragFrom, dragTo].map((px, i) => (
              <line
                key={i} x1={px} x2={px} y1={PAD.t} y2={PAD.t + innerH}
                stroke="var(--color-signal)" strokeWidth="1" vectorEffect="non-scaling-stroke"
              />
            ))}
            <text
              x={(dragFrom + dragTo) / 2} y={PAD.t + 12} textAnchor="middle"
              fill="var(--color-signal)" fontSize="10" fontFamily="ui-monospace, monospace"
            >
              {timeLabel(tAt(dragFrom))} – {timeLabel(tAt(dragTo))}
            </text>
          </g>
        )}

        {hoverX != null && !dragging && (
          <g>
            <line
              x1={hoverX} x2={hoverX} y1={PAD.t} y2={PAD.t + innerH}
              stroke="var(--color-fg-muted)" strokeWidth="1" vectorEffect="non-scaling-stroke"
            />
            {/* A dot per series at the crosshair, so the reading is anchored to
                the line rather than only to a number in a box. */}
            {series.map((s) => {
              const v = readAt(s)
              return v == null ? null : (
                <circle key={s.label} cx={hoverX} cy={y(v)} r="3"
                        fill={s.colour} stroke="var(--color-ink-950)" strokeWidth="1.5" />
              )
            })}
          </g>
        )}

        <text x={PAD.l} y={height - 6} fill="var(--color-fg-dim)" fontSize="10" fontFamily="ui-monospace, monospace">
          {timeLabel(model.t0)}
        </text>
        <text x={W - PAD.r} y={height - 6} textAnchor="end" fill="var(--color-fg-dim)" fontSize="10" fontFamily="ui-monospace, monospace">
          {timeLabel(model.t1)}
        </text>
      </svg>

      {hoverT != null && hoverX != null && !dragging && (
        <div
          className="pointer-events-none absolute top-1 z-10 whitespace-nowrap border border-[var(--color-line)] bg-[var(--color-ink-950)] px-2.5 py-1.5 shadow-lg"
          style={{
            // Flip to the left of the cursor past halfway so the tooltip never
            // runs off the right edge of the chart.
            left: hoverX / W > 0.6 ? undefined : `${(hoverX / W) * 100}%`,
            right: hoverX / W > 0.6 ? `${100 - (hoverX / W) * 100}%` : undefined,
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

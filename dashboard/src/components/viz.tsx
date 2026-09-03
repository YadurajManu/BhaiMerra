import { useId, useMemo, useState } from 'react'

/**
 * Telemetry charts.
 *
 * Two rules shape everything here.
 *
 * Fleet's green, amber and red are *status* colours — healthy, degraded, down.
 * They are never used to mean "which node", because a node coloured with the
 * healthy green would say something the chart does not mean. Node identity gets
 * its own palette, below.
 *
 * That palette is not chosen by eye. It was run through a colour-vision
 * validator per mode: every hue sits inside the mode's lightness band, clears
 * the chroma floor so it does not read as grey, keeps every adjacent pair
 * separable under deuteranopia, protanopia and tritanopia, and holds 3:1
 * against the surface behind it. The order matters as much as the values —
 * magenta beside teal collapses to ΔE 3.2 under deuteranopia, which is
 * invisible, and reordering is what fixed it.
 */

/** Node identity. Fixed order, never cycled — colour follows the node, not its rank. */
export const SERIES_DARK = ['#d6409f', '#3987e5', '#12a594', '#9a6bd8', '#a16207']
export const SERIES_LIGHT = ['#c02a8a', '#1d63c9', '#0d8b7c', '#7c4fc4', '#8a5410']

function usePrefersDark() {
  const [dark, setDark] = useState(
    () => typeof matchMedia !== 'undefined' && matchMedia('(prefers-color-scheme: dark)').matches
  )
  useMemo(() => {
    if (typeof matchMedia === 'undefined') return
    const mq = matchMedia('(prefers-color-scheme: dark)')
    const on = () => setDark(mq.matches)
    mq.addEventListener?.('change', on)
    return () => mq.removeEventListener?.('change', on)
  }, [])
  return dark
}

/** The dashboard is dark-first, so this defaults to the dark steps. */
export function useSeriesColors() {
  const dark = usePrefersDark()
  return dark ? SERIES_DARK : SERIES_DARK // dashboard has no light mode yet
}

/* ── sparkline ──────────────────────────────────────────────────────── */

type SparkProps = {
  points: Array<number | null>
  width?: number
  height?: number
  /** Fixed ceiling. Without one, a flat 3% line looks identical to a flat 90% one. */
  max?: number
  /** Drawn in muted ink; only the final point carries colour. */
  tone?: 'signal' | 'warn' | 'down' | 'muted'
  /** A node that stopped reporting: the line greys out and the end is marked. */
  frozen?: boolean
  label?: string
}

const TONE: Record<string, string> = {
  signal: 'var(--color-signal)',
  warn: 'var(--color-warn)',
  down: 'var(--color-down)',
  muted: 'var(--color-fg-dim)',
}

/**
 * A sparkline is context for a number, not a chart.
 *
 * No axes, no grid, no legend — those belong to something you read, and this is
 * something you glance at. Its whole job is turning "21%" into "21%, and it has
 * been climbing for an hour".
 */
export function Sparkline({
  points,
  width = 64,
  height = 18,
  max,
  tone = 'muted',
  frozen = false,
  label,
}: SparkProps) {
  const id = useId()
  const clean = points.filter((p): p is number => p != null && Number.isFinite(p))
  if (clean.length < 2) {
    return (
      <span
        className="inline-block align-middle text-[var(--color-fg-dim)]"
        style={{ width, height }}
        aria-hidden="true"
      />
    )
  }

  const ceiling = max ?? Math.max(...clean, 1)
  const floor = 0
  const span = Math.max(ceiling - floor, 1e-6)
  const stepX = width / (clean.length - 1)

  const xy = clean.map((v, i) => {
    const x = i * stepX
    // 1.5px inset top and bottom so a value pinned at 0 or max is not a
    // half-clipped stroke sitting on the edge of the box.
    const y = height - 1.5 - ((v - floor) / span) * (height - 3)
    return [x, y] as const
  })

  const d = xy.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`).join('')
  const area = `${d}L${width},${height}L0,${height}Z`
  const [lastX, lastY] = xy[xy.length - 1]!
  const colour = frozen ? 'var(--color-fg-dim)' : TONE[tone]

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className="inline-block align-middle overflow-visible"
      role="img"
      aria-label={label ?? 'trend'}
    >
      <defs>
        <linearGradient id={`sp-${id}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={colour} stopOpacity={frozen ? 0.1 : 0.22} />
          <stop offset="100%" stopColor={colour} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#sp-${id})`} />
      <path
        d={d}
        fill="none"
        stroke={colour}
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity={frozen ? 0.55 : 1}
        // A dashed tail is how a stopped node reads as stopped rather than flat.
        strokeDasharray={frozen ? '2 2' : undefined}
      />
      {/* The endpoint is the value the number beside it shows. Emphasising it
          ties the two together without a label. */}
      <circle
        cx={lastX}
        cy={lastY}
        r={frozen ? 1.8 : 2.1}
        fill={frozen ? 'var(--color-ink-950)' : colour}
        stroke={colour}
        strokeWidth={frozen ? 1 : 0}
      />
    </svg>
  )
}

/* ── heartbeat strip ────────────────────────────────────────────────── */

/**
 * Uptime as a texture.
 *
 * One bar per interval, present or missing. "4s ago" tells you the last beat
 * landed; this tells you whether the last hundred did. Status colours are
 * correct here — this genuinely is a good/bad state, not an identity.
 */
export function HeartbeatStrip({
  beats,
  height = 16,
  label,
}: {
  beats: Array<'ok' | 'missed' | 'nodata'>
  height?: number
  label?: string
}) {
  if (!beats.length) return null
  const recorded = beats.filter((b) => b !== 'nodata')
  const ok = recorded.filter((b) => b === 'ok').length

  return (
    <div
      className="flex flex-1 items-end gap-[2px]"
      style={{ height }}
      role="img"
      aria-label={label ?? `${ok} of ${recorded.length} recorded intervals reported`}
    >
      {beats.map((b, i) => (
        <span
          key={i}
          className="min-w-[2px] flex-1 rounded-[1px]"
          style={
            b === 'nodata'
              ? // Not a missed beat — nothing was being recorded yet. A faint
                // baseline says "no evidence" without crying wolf.
                { height: 2, background: 'var(--color-line-2)' }
              : b === 'ok'
                ? { height, background: 'var(--color-signal)', opacity: 0.85 }
                : { height: Math.round(height * 0.6), background: 'var(--color-down)' }
          }
        />
      ))}
    </div>
  )
}

/* ── stacked area ───────────────────────────────────────────────────── */

export type Series = { key: string; label: string; points: Array<{ t: number; v: number }> }

/**
 * Composition over time — which machine is carrying the fleet.
 *
 * Stacked because the question is "how much in total, and whose", and a
 * multi-line chart answers neither well. Every segment is separated by a 2px
 * surface gap so adjacent bands stay distinguishable even where two colours are
 * close, which is the secondary encoding that keeps this readable without
 * relying on hue alone.
 */
export function StackedArea({
  series,
  height = 160,
  unit = '',
  formatValue = (v: number) => String(Math.round(v)),
}: {
  series: Series[]
  height?: number
  unit?: string
  formatValue?: (v: number) => string
}) {
  const colours = useSeriesColors()
  const [hover, setHover] = useState<number | null>(null)
  const id = useId()

  const { stacks, times, peak } = useMemo(() => {
    const times = [...new Set(series.flatMap((s) => s.points.map((p) => p.t)))].sort((a, b) => a - b)
    const byKey = series.map((s) => new Map(s.points.map((p) => [p.t, p.v])))
    const stacks: number[][] = []
    let peak = 0
    for (const t of times) {
      let acc = 0
      const col: number[] = []
      byKey.forEach((m) => {
        acc += m.get(t) ?? 0
        col.push(acc)
      })
      stacks.push(col)
      peak = Math.max(peak, acc)
    }
    return { stacks, times, peak: peak || 1 }
  }, [series])

  if (times.length < 2) {
    return (
      <div
        className="flex items-center justify-center border border-dashed border-[var(--color-line)] font-mono text-[11px] text-[var(--color-fg-dim)]"
        style={{ height }}
      >
        not enough history yet — this fills in as nodes report
      </div>
    )
  }

  const W = 100 // viewBox units; the SVG scales to its container
  const stepX = W / (times.length - 1)
  const y = (v: number) => height - (v / peak) * (height - 8)

  const bands = series.map((s, si) => {
    const upper = stacks.map((col, i) => `${i === 0 ? 'M' : 'L'}${(i * stepX).toFixed(2)},${y(col[si]!).toFixed(1)}`).join('')
    const lower = stacks
      .map((col, i) => [i, si === 0 ? 0 : col[si - 1]!] as const)
      .reverse()
      .map(([i, v]) => `L${(i * stepX).toFixed(2)},${y(v).toFixed(1)}`)
      .join('')
    return { d: `${upper}${lower}Z`, colour: colours[si % colours.length]!, label: s.label }
  })

  // Narrowed to a local so TypeScript keeps the non-null through the closure.
  const hi = hover
  const hoverTotals =
    hi == null
      ? null
      : series.map((s, si) => ({
          label: s.label,
          colour: colours[si % colours.length]!,
          v: stacks[hi]![si]! - (si === 0 ? 0 : stacks[hi]![si - 1]!),
        }))

  return (
    <div className="relative">
      <svg
        viewBox={`0 0 ${W} ${height}`}
        preserveAspectRatio="none"
        className="w-full"
        style={{ height }}
        onMouseLeave={() => setHover(null)}
        onMouseMove={(e) => {
          const r = e.currentTarget.getBoundingClientRect()
          const frac = (e.clientX - r.left) / r.width
          setHover(Math.max(0, Math.min(times.length - 1, Math.round(frac * (times.length - 1)))))
        }}
        role="img"
        aria-label="Fleet memory use over time, stacked per node"
      >
        {/* Recessive grid: present enough to read a level against, quiet enough
            to stay behind the data. */}
        {[0.25, 0.5, 0.75].map((f) => (
          <line
            key={f}
            x1="0" x2={W}
            y1={y(peak * f)} y2={y(peak * f)}
            stroke="var(--color-line)" strokeWidth="0.5" vectorEffect="non-scaling-stroke"
          />
        ))}

        {bands.map((b, i) => (
          <path
            key={i}
            d={b.d}
            fill={b.colour}
            fillOpacity={hover == null ? 0.72 : 0.5}
            // A 2px surface-coloured seam between segments. This is what keeps
            // two adjacent bands legible when their hues are close, and it is
            // the secondary encoding the palette check asks for.
            stroke="var(--color-ink-950)"
            strokeWidth="2"
            vectorEffect="non-scaling-stroke"
            strokeLinejoin="round"
          />
        ))}

        {hover != null && (
          <line
            x1={hover * stepX} x2={hover * stepX} y1="0" y2={height}
            stroke="var(--color-fg-dim)" strokeWidth="1" vectorEffect="non-scaling-stroke"
          />
        )}
      </svg>

      {/* Legend is always present for two or more series, so identity is never
          carried by colour alone. */}
      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5">
        {series.map((s, i) => (
          <span key={s.key} className="flex items-center gap-1.5 font-mono text-[10.5px] text-[var(--color-fg-muted)]">
            <span
              className="h-2 w-2 shrink-0 rounded-[1px]"
              style={{ background: colours[i % colours.length] }}
            />
            {s.label}
          </span>
        ))}
      </div>

      {hoverTotals && (
        <div className="pointer-events-none absolute left-0 top-0 border border-[var(--color-line)] bg-[var(--color-ink-950)] px-3 py-2 shadow-lg">
          <div className="font-mono text-[10px] uppercase tracking-[0.1em] text-[var(--color-fg-dim)]">
            {new Date(times[hi!]!).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          </div>
          {hoverTotals.map((h) => (
            <div key={h.label} className="mt-1 flex items-center gap-2 font-mono text-[11px]">
              <span className="h-2 w-2 rounded-[1px]" style={{ background: h.colour }} />
              <span className="text-[var(--color-fg-muted)]">{h.label}</span>
              <span className="ml-auto tabular-nums text-[var(--color-fg)]">
                {formatValue(h.v)}{unit}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/* ── disk projection ────────────────────────────────────────────────── */

/**
 * "Full in nine days" is the sentence someone acts on. A percentage is not.
 *
 * Fits a line through the samples and reports when it reaches capacity. Returns
 * null rather than a guess when the trend is flat, falling, or too short to
 * mean anything — a made-up date is worse than no date.
 */
export function projectFull(
  points: Array<{ t: number; used: number }>,
  totalMb: number
): { days: number; at: Date } | null {
  if (points.length < 6 || !totalMb) return null

  const n = points.length
  const t0 = points[0]!.t
  const xs = points.map((p) => (p.t - t0) / 86_400_000) // days
  const ys = points.map((p) => p.used)
  const mx = xs.reduce((a, b) => a + b, 0) / n
  const my = ys.reduce((a, b) => a + b, 0) / n
  let num = 0
  let den = 0
  for (let i = 0; i < n; i++) {
    num += (xs[i]! - mx) * (ys[i]! - my)
    den += (xs[i]! - mx) ** 2
  }
  if (den === 0) return null

  const slopeMbPerDay = num / den
  // Under ~50 MB/day is noise, not a trend, and would produce absurd horizons.
  if (slopeMbPerDay < 50) return null

  const remaining = totalMb - ys[n - 1]!
  if (remaining <= 0) return null

  const days = remaining / slopeMbPerDay
  if (days > 365) return null // far enough away to be meaningless

  return { days, at: new Date(Date.now() + days * 86_400_000) }
}

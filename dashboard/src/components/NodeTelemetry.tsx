import { useMemo, useState } from 'react'
import type { Node } from '../lib/api'
import { useSamples, beatsFrom } from '../lib/useSamples'
import { mb, since } from '../lib/format'
import { Sparkline, HeartbeatStrip, projectFull } from './viz'

/**
 * A node's numbers, with the hour behind them.
 *
 * Laid out as an explicit grid — name, bar, value, trend — rather than a flex
 * row with a fixed-width label. The first version used `Meter`, whose label is
 * `w-[112px] whitespace-nowrap`; "RAM 16.8 GB / 18.0 GB" is wider than that, so
 * it overflowed its box and the sparkline was drawn straight through the text.
 * Columns cannot collide, so the fix is columns.
 */

type Row = {
  key: string
  name: string
  value: number
  max: number
  display: string
  points: Array<number | null>
  warnAt: number
}

function MetricRow({ row, expanded }: { row: Row; expanded: boolean }) {
  const ratio = row.max > 0 ? Math.min(1, row.value / row.max) : 0
  const warn = ratio >= row.warnAt
  const colour = warn ? 'var(--color-warn)' : 'var(--color-signal)'

  return (
    <div className="grid grid-cols-[3rem_1fr_auto] items-center gap-x-3 gap-y-1.5 sm:grid-cols-[3rem_1fr_auto_auto]">
      <span className="font-mono text-[10.5px] uppercase tracking-[0.1em] text-[var(--color-fg-dim)]">
        {row.name}
      </span>

      <span className="h-[4px] w-full min-w-0 rounded-[2px] bg-[var(--color-line)]">
        <span
          className="block h-full rounded-[2px] transition-[width] duration-700"
          style={{ width: `${ratio * 100}%`, background: colour }}
        />
      </span>

      {/* tabular-nums so the numbers line up down the column as they change */}
      <span
        className="whitespace-nowrap text-right font-mono text-[11px] tabular-nums"
        style={{ color: warn ? 'var(--color-warn)' : 'var(--color-fg-muted)' }}
      >
        {row.display}
      </span>

      {/* Its own column, and hidden on narrow screens rather than allowed to
          squeeze into the value. */}
      <span className="hidden sm:block">
        <Sparkline
          points={row.points}
          max={row.max}
          width={expanded ? 150 : 72}
          height={expanded ? 34 : 20}
          tone={warn ? 'warn' : 'signal'}
          label={`${row.name} over the last hour, now ${row.display}`}
        />
      </span>
    </div>
  )
}

export default function NodeTelemetry({ node, fleetId }: { node: Node; fleetId?: string }) {
  const [expanded, setExpanded] = useState(false)
  const { samples } = useSamples(fleetId, node.id, expanded ? 360 : 60)
  const t = node.telemetry

  const beats = useMemo(() => beatsFrom(samples), [samples])

  /**
   * Capacity, not free space.
   *
   * node.diskMb is FREE disk — what the scheduler places against. Rendering
   * "used / diskMb" as though it were the total is how a node showed an
   * impossible "395.7 GB / 68.6 GB". Newer agents send the real total; for
   * older ones, used + free is exactly that.
   */
  const diskTotal =
    t?.diskTotalMb ?? (t?.diskUsedMb != null && node.diskMb ? t.diskUsedMb + node.diskMb : 0)

  const rows: Row[] = useMemo(() => {
    if (!t) return []
    const out: Row[] = [
      {
        key: 'cpu',
        name: 'cpu',
        value: t.cpuPct,
        max: 100,
        display: `${Math.round(t.cpuPct)}%`,
        points: samples.map((s) => s.cpuPct),
        warnAt: 0.8,
      },
      {
        key: 'ram',
        name: 'ram',
        value: t.ramUsedMb ?? 0,
        max: node.ramMb,
        display: `${mb(t.ramUsedMb ?? 0)} / ${mb(node.ramMb)}`,
        points: samples.map((s) => s.ramUsedMb),
        warnAt: 0.85,
      },
    ]
    if (diskTotal > 0) {
      out.push({
        key: 'disk',
        name: 'disk',
        value: t.diskUsedMb || 0,
        max: diskTotal,
        display: `${mb(t.diskUsedMb || 0)} / ${mb(diskTotal)}`,
        points: samples.map((s) => s.diskUsedMb),
        warnAt: 0.9,
      })
    }
    return out
  }, [t, samples, node.ramMb, diskTotal])

  const projection = useMemo(() => {
    const disk = samples
      .filter((s) => s.diskUsedMb != null)
      .map((s) => ({ t: new Date(s.at).getTime(), used: s.diskUsedMb! }))
    return diskTotal ? projectFull(disk, diskTotal) : null
  }, [samples, diskTotal])

  const recorded = beats.filter((b) => b !== 'nodata')
  const okBeats = recorded.filter((b) => b === 'ok').length

  /* An offline node still has history. Where the line stopped is how you tell
     "died under load" from "someone closed the lid". */
  if (!t) {
    const hasHistory = samples.filter((s) => s.cpuPct != null).length > 1
    return (
      <div className="mt-4 rounded-[3px] border border-[var(--color-line)] bg-[var(--color-ink-900)] p-4">
        <p className="font-mono text-[11px] text-[var(--color-fg-dim)]">
          No live telemetry — node last heartbeated {since(node.lastHeartbeatAt)}.
        </p>
        {hasHistory && (
          <div className="mt-3.5 space-y-2.5 border-t border-[var(--color-line)] pt-3.5">
            <div className="mono-label text-[9px] text-[var(--color-fg-dim)]">LAST SEEN DOING</div>
            {(
              [
                ['cpu', samples.map((s) => s.cpuPct), 100],
                ['ram', samples.map((s) => s.ramUsedMb), node.ramMb],
              ] as const
            ).map(([name, pts, max]) => (
              <div key={name} className="grid grid-cols-[3rem_1fr] items-center gap-3">
                <span className="font-mono text-[10.5px] uppercase tracking-[0.1em] text-[var(--color-fg-dim)]">
                  {name}
                </span>
                <Sparkline points={pts} max={max} width={150} height={24} frozen label={`${name} before it stopped`} />
              </div>
            ))}
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="mt-4 rounded-[3px] border border-[var(--color-line)] bg-[var(--color-ink-900)]">
      <div className="space-y-3 p-4">
        {rows.map((r) => (
          <MetricRow key={r.key} row={r} expanded={expanded} />
        ))}
      </div>

      {projection && (
        <p
          className="px-4 pb-3 font-mono text-[10.5px]"
          style={{ color: projection.days < 14 ? 'var(--color-warn)' : 'var(--color-fg-dim)' }}
        >
          at this rate, disk is full in{' '}
          {projection.days < 1 ? 'under a day' : `${Math.round(projection.days)} days`}
        </p>
      )}

      {beats.length > 0 && (
        <div className="flex items-center gap-3 border-t border-[var(--color-line)] px-4 py-3">
          <span className="mono-label shrink-0 text-[9px] text-[var(--color-fg-dim)]">
            {expanded ? 'LAST 6H' : 'LAST HOUR'}
          </span>
          <HeartbeatStrip beats={beats} />
          <span className="shrink-0 font-mono text-[10px] tabular-nums text-[var(--color-fg-dim)]">
            {recorded.length ? `${okBeats}/${recorded.length}` : 'no history yet'}
          </span>
        </div>
      )}

      {/* z-10 because the node card makes its whole surface a link with a
          stretched pseudo-element. Without it this toggle sits underneath and
          navigates instead of expanding. Raising the whole telemetry block
          instead would shield the meters and sparklines, which is the part
          people actually click. */}
      <button
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        className="relative z-10 w-full border-t border-[var(--color-line)] px-4 py-2 text-left font-mono text-[10.5px] text-[var(--color-fg-dim)] transition-colors duration-300 hover:bg-[var(--color-ink-800)] hover:text-[var(--color-fg-muted)]"
      >
        {expanded ? '− less' : '+ six hours, larger charts'}
      </button>
    </div>
  )
}

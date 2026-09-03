import { useMemo } from 'react'
import type { Node } from '../lib/api'
import { useSamples, beatsFrom } from '../lib/useSamples'
import { mb, since } from '../lib/format'
import { Meter } from './ui'
import { Sparkline, HeartbeatStrip, projectFull } from './viz'

/**
 * A node's numbers, with the hour behind them.
 *
 * Every reading here used to be an instant: 21% told you nothing about whether
 * it was 4% ten minutes ago. The sparklines are the smallest change that fixes
 * that — no extra page, no click, and the trend sits where the number already
 * was.
 */
export default function NodeTelemetry({ node, fleetId }: { node: Node; fleetId?: string }) {
  const { samples } = useSamples(fleetId, node.id, 60)

  const series = useMemo(() => {
    const cpu = samples.map((s) => s.cpuPct)
    const ram = samples.map((s) => s.ramUsedMb)
    const disk = samples
      .filter((s) => s.diskUsedMb != null)
      .map((s) => ({ t: new Date(s.at).getTime(), used: s.diskUsedMb! }))
    return { cpu, ram, disk }
  }, [samples])

  const beats = useMemo(() => beatsFrom(samples), [samples])
  const t = node.telemetry

  /**
   * Capacity, not free space.
   *
   * node.diskMb is FREE disk — it is what the scheduler places against. This
   * panel rendered "used / diskMb" as though it were the total, which is why a
   * node with more used than free showed an impossible reading like
   * "395.7 GB / 68.6 GB". Newer agents report the real total; for older ones,
   * used + free is exactly the total anyway.
   */
  const diskTotal =
    t?.diskTotalMb ?? (t?.diskUsedMb != null && node.diskMb ? t.diskUsedMb + node.diskMb : 0)

  const projection = useMemo(
    () => (diskTotal ? projectFull(series.disk, diskTotal) : null),
    [series.disk, diskTotal]
  )

  /* An offline node is not a node with nothing to say. It has history, and
     where the line stopped is how you tell "died under load" from "lid closed". */
  if (!t) {
    const hasHistory = series.cpu.length > 1
    return (
      <div className="mt-4 rounded-[3px] border border-[var(--color-line)] bg-[var(--color-ink-900)] p-3.5">
        <p className="font-mono text-[11px] text-[var(--color-fg-dim)]">
          No live telemetry — node last heartbeated {since(node.lastHeartbeatAt)}.
        </p>
        {hasHistory && (
          <div className="mt-3 space-y-2 border-t border-[var(--color-line)] pt-3">
            <div className="mono-label text-[9px] text-[var(--color-fg-dim)]">
              LAST SEEN DOING
            </div>
            <div className="flex items-center justify-between gap-3">
              <span className="font-mono text-[11px] text-[var(--color-fg-dim)]">cpu</span>
              <Sparkline points={series.cpu} max={100} frozen label="CPU before it stopped" />
            </div>
            <div className="flex items-center justify-between gap-3">
              <span className="font-mono text-[11px] text-[var(--color-fg-dim)]">memory</span>
              <Sparkline points={series.ram} max={node.ramMb} frozen label="Memory before it stopped" />
            </div>
          </div>
        )}
      </div>
    )
  }

  const ramUsed = t.ramUsedMb ?? 0

  return (
    <div className="mt-4 rounded-[3px] border border-[var(--color-line)] bg-[var(--color-ink-900)] p-3.5">
      <div className="space-y-2.5">
        <div className="flex items-center gap-3">
          <div className="min-w-0 flex-1">
            <Meter value={t.cpuPct} max={100} label={`CPU ${Math.round(t.cpuPct)}%`} warnAt={0.8} />
          </div>
          <Sparkline
            points={series.cpu}
            max={100}
            tone={t.cpuPct > 80 ? 'warn' : 'signal'}
            label={`CPU over the last hour, now ${Math.round(t.cpuPct)}%`}
          />
        </div>

        <div className="flex items-center gap-3">
          <div className="min-w-0 flex-1">
            <Meter
              value={ramUsed}
              max={node.ramMb}
              label={`RAM ${mb(ramUsed)} / ${mb(node.ramMb)}`}
              warnAt={0.85}
            />
          </div>
          <Sparkline
            points={series.ram}
            max={node.ramMb}
            tone={ramUsed / node.ramMb > 0.85 ? 'warn' : 'signal'}
            label={`Memory over the last hour, now ${mb(ramUsed)}`}
          />
        </div>

        {diskTotal > 0 && (
          <div className="flex items-center gap-3">
            <div className="min-w-0 flex-1">
              <Meter
                value={t.diskUsedMb || 0}
                max={diskTotal}
                label={`Disk ${mb(t.diskUsedMb || 0)} / ${mb(diskTotal)}`}
                warnAt={0.9}
              />
            </div>
            <Sparkline
              points={samples.map((s) => s.diskUsedMb)}
              max={diskTotal}
              tone={(t.diskUsedMb || 0) / diskTotal > 0.9 ? 'warn' : 'signal'}
              label="Disk over the last hour"
            />
          </div>
        )}
      </div>

      {/* "Full in nine days" is the sentence someone acts on. A percentage is
          not. Absent unless the trend is real, because an invented date is
          worse than none. */}
      {projection && (
        <p
          className="mt-3 font-mono text-[10.5px]"
          style={{ color: projection.days < 14 ? 'var(--color-warn)' : 'var(--color-fg-dim)' }}
        >
          at this rate, disk is full in {projection.days < 1 ? 'under a day' : `${Math.round(projection.days)} days`}
        </p>
      )}

      {beats.length > 0 && (
        <div className="mt-3 flex items-center gap-3 border-t border-[var(--color-line)] pt-3">
          <span className="mono-label shrink-0 text-[9px] text-[var(--color-fg-dim)]">
            LAST HOUR
          </span>
          <HeartbeatStrip
            beats={beats}
            label={`${beats.filter(Boolean).length} of ${beats.length} intervals reported`}
          />
          <span className="ml-auto shrink-0 font-mono text-[10px] tabular-nums text-[var(--color-fg-dim)]">
            {beats.filter(Boolean).length}/{beats.length}
          </span>
        </div>
      )}
    </div>
  )
}

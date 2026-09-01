import { useEffect, useRef, useState } from 'react'
import { api } from '../lib/api'

/**
 * A deploy, while it is happening.
 *
 * The dashboard used to render "Deploying…" and then nothing for four minutes,
 * which is indistinguishable from a hang — so the only way to know whether a
 * deploy was progressing was to run the CLI beside it. The control plane has
 * been publishing this the whole time and the CLI has been consuming it; this
 * is the browser finally reading the same stream.
 */

/** Mirrors `DeployProgress` on the server and in the CLI. */
type DeployProgress = {
  deploymentId: string
  status: string
  since: string
  nodeName: string | null
  failureReason: string | null
  detail?: string
  step?: number
  ofSteps?: number
  platform?: string
}

/**
 * The phases a deploy passes through, in order.
 *
 * `pinned_unavailable` is deliberately absent: it is not a phase but a verdict,
 * and showing it as a step implies the deploy is still moving toward something.
 */
const STEPS = [
  { key: 'queued', label: 'queued' },
  { key: 'building', label: 'building the image' },
  { key: 'pushing', label: 'pushing to the registry' },
  { key: 'scheduling', label: 'scheduling onto the node' },
  { key: 'deploying', label: 'waiting for the container' },
  { key: 'running', label: 'running' },
] as const

const indexOf = (status: string) => STEPS.findIndex((s) => s.key === status)

export default function DeployProgress({
  serviceId,
  onSettled,
}: {
  serviceId: string
  /** Fired once the deploy reaches a state it will not leave on its own. */
  onSettled?: (status: string) => void
}) {
  const [progress, setProgress] = useState<DeployProgress | null>(null)
  const settled = useRef(false)

  useEffect(() => {
    let alive = true
    settled.current = false

    const tick = async () => {
      try {
        const { progress: p } = await api<{ progress: DeployProgress | null }>(
          `/services/${serviceId}/progress`
        )
        if (!alive) return
        setProgress(p)
        if (p && (p.status === 'running' || p.status === 'failed') && !settled.current) {
          settled.current = true
          onSettled?.(p.status)
        }
      } catch {
        // A dropped poll is not worth showing; the next one will say the same
        // thing or better.
      }
    }

    void tick()
    // Fast enough to feel live, slow enough not to be a load generator. The
    // server rate-limits its own writes to four a second regardless.
    const id = setInterval(tick, 1200)
    return () => {
      alive = false
      clearInterval(id)
    }
  }, [serviceId, onSettled])

  if (!progress) return null

  const failed = progress.status === 'failed'
  const current = indexOf(progress.status)
  const sub =
    progress.detail &&
    [
      progress.step && progress.ofSteps ? `${progress.step}/${progress.ofSteps}` : null,
      progress.platform?.replace(/^linux\//, ''),
      progress.detail,
    ]
      .filter(Boolean)
      .join(' ')

  return (
    <div className="rise-in mt-3 rounded-[3px] border border-[var(--color-line)] bg-[var(--color-ink-900)] p-3.5">
      <ol className="grid gap-1.5">
        {STEPS.map((step, i) => {
          const done = current > i
          const active = current === i && !failed
          const stalled = failed && current === i
          return (
            <li key={step.key} className="flex items-center gap-2.5 font-mono text-[11px]">
              <span
                aria-hidden="true"
                className={`inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full border text-[8px] ${
                  stalled
                    ? 'border-[var(--color-down)] text-[var(--color-down)]'
                    : done
                      ? 'border-[var(--color-signal-dim)] bg-[color-mix(in_oklab,var(--color-signal)_20%,transparent)] text-[var(--color-signal)]'
                      : active
                        ? 'border-[var(--color-warn)] text-[var(--color-warn)]'
                        : 'border-[var(--color-line-2)] text-transparent'
                }`}
              >
                {stalled ? '×' : done ? '✓' : active ? '' : ''}
              </span>
              <span
                className={
                  stalled
                    ? 'text-[var(--color-down)]'
                    : done
                      ? 'text-[var(--color-fg-muted)]'
                      : active
                        ? 'breathe text-[var(--color-fg)]'
                        : 'text-[var(--color-fg-dim)]'
                }
              >
                {step.label}
                {active && progress.nodeName && step.key === 'scheduling' && ` — ${progress.nodeName}`}
              </span>
            </li>
          )
        })}
      </ol>

      {/* The build's own output, which is the part that actually takes minutes. */}
      {sub && !failed && (
        <p className="mt-2.5 truncate border-t border-[var(--color-line)] pt-2 font-mono text-[10.5px] text-[var(--color-fg-dim)]">
          {sub}
        </p>
      )}

      {failed && progress.failureReason && (
        <p className="mt-2.5 border-t border-[var(--color-line)] pt-2 font-mono text-[10.5px] leading-relaxed text-[var(--color-down)]">
          {progress.failureReason.split('\n').find((l) => l.trim())?.slice(0, 200)}
        </p>
      )}
    </div>
  )
}

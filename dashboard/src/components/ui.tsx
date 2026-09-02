import type { ReactNode } from 'react'
import { useEffect, useState } from 'react'
import { TONE_TEXT, toneOf } from '../lib/format'

/* The mark from the marketing site: six peers, one live, wired into a mesh. */
export function Logo({ size = 20, word = false }: { size?: number; word?: boolean }) {
  const nodes = [
    [9, 9, 3.1, 1], [26, 6, 2, 0], [33, 19, 2.4, 0],
    [20, 17.5, 1.6, 0], [24, 31, 2.2, 0], [8, 26, 1.9, 0],
  ] as const
  const edges = [[0, 3], [3, 1], [3, 2], [0, 5], [5, 4], [4, 2], [1, 2], [0, 1]] as const
  return (
    <span className="inline-flex items-center gap-2.5">
      <svg width={size} height={size} viewBox="0 0 40 40" fill="none" aria-hidden="true" className="shrink-0">
        {edges.map(([a, b], i) => (
          <line key={i} x1={nodes[a]![0]} y1={nodes[a]![1]} x2={nodes[b]![0]} y2={nodes[b]![1]} stroke="#4a5763" strokeWidth="1.05" />
        ))}
        {nodes.map(([x, y, r, live], i) => (
          <circle key={i} cx={x} cy={y} r={r} fill={live ? 'var(--color-signal)' : '#8d99a6'} />
        ))}
      </svg>
      {word && (
        <span className="font-mono font-medium tracking-[0.01em]" style={{ fontSize: size * 0.66 }}>
          fleet<span className="text-[var(--color-fg-dim)]">·</span>os
        </span>
      )}
    </span>
  )
}

export function Dot({ tone = 'ok', size = 7 }: { tone?: 'ok' | 'warn' | 'down' | 'idle'; size?: number }) {
  const colour = { ok: 'var(--color-signal)', warn: 'var(--color-warn)', down: 'var(--color-down)', idle: 'var(--color-fg-dim)' }[tone]
  // Only genuinely-live states pulse. A pulsing "offline" dot would be a lie.
  const animation = tone === 'ok' ? 'signal-pulse 2.4s ease-out infinite' : tone === 'warn' ? 'warn-pulse 1.6s ease-out infinite' : undefined
  return <span className="inline-block shrink-0 rounded-full" style={{ width: size, height: size, background: colour, animation }} />
}

export function StatusPill({ status }: { status: string }) {
  const tone = toneOf(status)
  return (
    <span className={`inline-flex items-center gap-1.5 font-mono text-[10.5px] uppercase tracking-[0.1em] ${TONE_TEXT[tone]}`}>
      <Dot tone={tone} size={5} />
      {status.replace(/_/g, ' ')}
    </span>
  )
}

export function Panel({ title, right, children, className = '' }: { title?: string; right?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`panel ${className}`}>
      {title && (
        <div className="panel-head flex items-center justify-between gap-3">
          <span>{title}</span>
          {right}
        </div>
      )}
      {children}
    </section>
  )
}

export function Button({
  children, variant = 'ghost', className = '', ...rest
}: { variant?: 'primary' | 'ghost' | 'danger' } & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  const styles = {
    primary: 'bg-[var(--color-signal)] text-[#04140c] hover:bg-[#55ee9c] disabled:opacity-50',
    ghost: 'border border-[var(--color-line-2)] text-[var(--color-fg)] hover:border-[var(--color-fg-dim)] hover:bg-[var(--color-ink-800)] disabled:opacity-40',
    danger: 'border border-[var(--color-line-2)] text-[var(--color-fg-muted)] hover:border-[var(--color-down)] hover:text-[var(--color-down)] disabled:opacity-40',
  }[variant]
  return (
    <button
      {...rest}
      className={`inline-flex items-center justify-center gap-2 rounded-[3px] px-3.5 py-2 font-mono text-[11.5px] transition-colors duration-300 disabled:cursor-not-allowed ${styles} ${className}`}
    >
      {children}
    </button>
  )
}

/**
 * A confirmation dialog for destructive actions.
 *
 * Replaces window.confirm/window.prompt for these: a native dialog cannot say
 * what is about to happen in more than one line, is styled by the browser, and
 * on `prompt` cannot show the value it wants typed next to the field. Deleting a
 * service or removing a node are the two actions in this app with consequences
 * that cannot be undone from the dashboard, so they are worth spelling out.
 *
 * Pass `confirmPhrase` to require the exact name to be typed — reserved for
 * actions that destroy state, not for ones that merely stop something.
 */
export function ConfirmDialog({
  open,
  title,
  body,
  consequences,
  confirmLabel,
  confirmPhrase,
  busy = false,
  onConfirm,
  onCancel,
}: {
  open: boolean
  title: string
  body?: ReactNode
  consequences?: string[]
  confirmLabel: string
  confirmPhrase?: string
  busy?: boolean
  onConfirm: () => void
  onCancel: () => void
}) {
  const [typed, setTyped] = useState('')

  // Reset between openings, or a second dialog inherits the first one's input
  // and its confirm button starts out already enabled.
  useEffect(() => {
    if (open) setTyped('')
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) onCancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, busy, onCancel])

  if (!open) return null

  // Case-insensitive on purpose. Field renders its label uppercased, so the
  // dialog asks for TYPE "WEB" and an exact comparison then rejects the WEB the
  // reader just copied off the screen. The friction that matters is having to
  // type the words at all, not reproducing their case from a label that changed
  // it. Trimmed too: selecting the phrase to copy usually takes a space with it.
  const ready =
    !confirmPhrase || typed.trim().toLowerCase() === confirmPhrase.trim().toLowerCase()

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onClick={() => { if (!busy) onCancel() }}
    >
      <div
        className="w-full max-w-[440px] rounded-[4px] border border-[var(--color-line-2)] bg-[var(--color-ink-900)] p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="font-mono text-[14px] text-[var(--color-fg)]">{title}</h2>
        {body && <div className="mt-2.5 text-[13px] leading-relaxed text-[var(--color-fg-muted)]">{body}</div>}

        {consequences && consequences.length > 0 && (
          <ul className="mt-3.5 space-y-1.5 border-l border-[var(--color-line-2)] pl-3">
            {consequences.map((line) => (
              <li key={line} className="font-mono text-[11px] leading-relaxed text-[var(--color-fg-dim)]">
                {line}
              </li>
            ))}
          </ul>
        )}

        {confirmPhrase && (
          <div className="mt-4">
            <Field
              label={`Type "${confirmPhrase}" to confirm`}
              autoFocus
              value={typed}
              autoComplete="off"
              spellCheck={false}
              placeholder={confirmPhrase}
              onChange={(e) => setTyped(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && ready && !busy) onConfirm() }}
            />
          </div>
        )}

        <div className="mt-5 flex justify-end gap-2">
          <Button onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button variant="danger" onClick={onConfirm} disabled={busy || !ready}>
            {busy ? 'working…' : confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  )
}

export function Field({ label, hint, ...rest }: { label: string; hint?: string } & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label className="block">
      <span className="mono-label">{label}</span>
      <input
        {...rest}
        className="mt-2 w-full rounded-[3px] border border-[var(--color-line)] bg-[var(--color-ink-950)] px-3.5 py-2.5 text-[14px] text-[var(--color-fg)] outline-none transition-colors duration-300 placeholder:text-[var(--color-fg-dim)] focus:border-[var(--color-line-2)]"
      />
      {hint && <span className="mt-1.5 block font-mono text-[10.5px] text-[var(--color-fg-dim)]">{hint}</span>}
    </label>
  )
}

/** A meter that says what it is measuring, with the number beside it. */
export function Meter({ value, max, label, warnAt = 0.85 }: { value: number; max: number; label?: string; warnAt?: number }) {
  const ratio = max > 0 ? Math.min(1, value / max) : 0
  const colour = ratio >= warnAt ? 'var(--color-warn)' : 'var(--color-signal-dim)'
  return (
    <div className="flex items-center gap-2.5">
      <span className="h-[3px] flex-1 bg-[var(--color-line)]">
        <span className="block h-full transition-[width] duration-700" style={{ width: `${ratio * 100}%`, background: colour }} />
      </span>
      {label && <span className="tabular w-[112px] shrink-0 whitespace-nowrap text-right font-mono text-[10px] text-[var(--color-fg-muted)]">{label}</span>}
    </div>
  )
}

/** Fills the trailing gap in a hairline grid so it does not read as an empty card. */
export function GridFiller({ count, columns = 2 }: { count: number; columns?: number }) {
  const missing = (columns - (count % columns)) % columns
  return (
    <>
      {Array.from({ length: missing }, (_, i) => (
        <div key={i} className="hidden bg-[var(--color-ink-950)] sm:block" />
      ))}
    </>
  )
}

export function Empty({ title, hint, action }: { title: string; hint?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-3 px-6 py-16 text-center">
      <Logo size={26} />
      <p className="text-[15px] text-[var(--color-fg)]">{title}</p>
      {hint && <p className="max-w-[46ch] text-[13px] leading-relaxed text-[var(--color-fg-muted)]">{hint}</p>}
      {action}
    </div>
  )
}

export function Copyable({ text, className = '' }: { text: string; className?: string }) {
  return (
    <button
      onClick={() => void navigator.clipboard?.writeText(text)}
      title="copy"
      className={`group inline-flex max-w-full items-center gap-2 truncate font-mono text-[11.5px] text-[var(--color-fg-muted)] transition-colors duration-300 hover:text-[var(--color-fg)] ${className}`}
    >
      <span className="truncate">{text}</span>
      <span className="shrink-0 text-[10px] text-[var(--color-fg-dim)] opacity-0 transition-opacity group-hover:opacity-100">copy</span>
    </button>
  )
}

export function ErrorNote({ error }: { error: unknown }) {
  if (!error) return null
  const message = error instanceof Error ? error.message : String(error)
  return (
    <div className="border-l-2 border-[var(--color-down)] bg-[color-mix(in_oklab,var(--color-down)_6%,transparent)] px-4 py-3">
      <div className="font-mono text-[10px] uppercase tracking-[0.14em] text-[var(--color-down)]">error</div>
      <p className="mt-1.5 text-[13px] leading-relaxed text-[var(--color-fg-muted)]">{message}</p>
    </div>
  )
}

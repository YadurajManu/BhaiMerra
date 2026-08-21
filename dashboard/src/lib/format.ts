export const mb = (v: number): string => (v >= 1024 ? `${(v / 1024).toFixed(1)} GB` : `${v} MB`)

export function since(iso: string | null | undefined): string {
  if (!iso) return 'never'
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000)
  const n = Math.abs(s)
  const suffix = s >= 0 ? 'ago' : 'from now'
  if (n < 60) return `${n}s ${suffix}`
  if (n < 3600) return `${Math.round(n / 60)}m ${suffix}`
  if (n < 86400) return `${Math.round(n / 3600)}h ${suffix}`
  return `${Math.round(n / 86400)}d ${suffix}`
}

export const pct = (v: number | null | undefined): string =>
  v === null || v === undefined ? '—' : `${Math.round(v * 100)}%`

/** Colour by meaning, never by decoration. */
export function toneOf(status: string): 'ok' | 'warn' | 'down' | 'idle' {
  switch (status) {
    case 'online':
    case 'running':
    case 'succeeded':
      return 'ok'
    case 'offline':
    case 'failed':
      return 'down'
    case 'cordoned':
    case 'draining':
    case 'deploying':
    case 'pinned_unavailable':
      return 'warn'
    default:
      return 'idle'
  }
}

export const TONE_TEXT: Record<string, string> = {
  ok: 'text-[var(--color-signal)]',
  warn: 'text-[var(--color-warn)]',
  down: 'text-[var(--color-down)]',
  idle: 'text-[var(--color-fg-dim)]',
}

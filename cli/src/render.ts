/** Terminal rendering. Colour is dropped when output is piped or NO_COLOR is set. */
const useColour = process.stdout.isTTY && !process.env.NO_COLOR

const ESC = '\x1b['
const wrap = (code: string) => (s: string) => (useColour ? `${ESC}${code}m${s}${ESC}0m` : s)

export const c = {
  dim: wrap('2'),
  bold: wrap('1'),
  green: wrap('32'),
  yellow: wrap('33'),
  red: wrap('31'),
  cyan: wrap('36'),
}

export const statusColour = (status: string): string => {
  switch (status) {
    case 'online':
    case 'running':
      return c.green(status)
    case 'offline':
    case 'failed':
      return c.red(status)
    case 'cordoned':
    case 'draining':
    case 'deploying':
    case 'pinned_unavailable':
      return c.yellow(status)
    default:
      return c.dim(status)
  }
}

/**
 * Column widths are measured on the visible text, not the escaped string —
 * otherwise colour codes count toward the width and every column drifts.
 */
// eslint-disable-next-line no-control-regex
const ANSI = new RegExp(`${'\\x1b'}\\[[0-9;]*m`, 'g')
const visibleLength = (s: string) => s.replace(ANSI, '').length

export function table(headers: string[], rows: string[][]): string {
  // Printing a header over nothing looks like a bug; callers handle the
  // empty case with a sentence instead.
  if (!rows.length) return ''

  const widths = headers.map((h, i) =>
    Math.max(visibleLength(h), ...rows.map((r) => visibleLength(r[i] ?? '')))
  )
  const pad = (s: string, width: number) => s + ' '.repeat(Math.max(0, width - visibleLength(s)))

  const head = headers.map((h, i) => c.dim(pad(h.toUpperCase(), widths[i]!))).join('  ')
  const body = rows.map((r) => r.map((cell, i) => pad(cell ?? '', widths[i]!)).join('  '))
  return [head, ...body].join('\n')
}

export function keyValues(pairs: Array<[string, string]>): string {
  const width = Math.max(...pairs.map(([k]) => k.length))
  return pairs.map(([k, v]) => `${c.dim(k.padEnd(width))}  ${v}`).join('\n')
}

/** Handles both directions: a heartbeat in the past, a token expiring ahead. */
export function relativeTime(iso: string | null | undefined): string {
  if (!iso) return 'never'
  const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000)
  const magnitude = Math.abs(seconds)
  const suffix = seconds >= 0 ? 'ago' : 'from now'

  if (magnitude < 60) return `${magnitude}s ${suffix}`
  if (magnitude < 3600) return `${Math.round(magnitude / 60)}m ${suffix}`
  if (magnitude < 86400) return `${Math.round(magnitude / 3600)}h ${suffix}`
  return `${Math.round(magnitude / 86400)}d ${suffix}`
}

export const mb = (value: number): string =>
  value >= 1024 ? `${(value / 1024).toFixed(1)}GB` : `${value}MB`

export { visibleLength }

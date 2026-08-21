/** Terminal rendering. Colour is dropped when output is piped or NO_COLOR is set. */
const useColour = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR

/**
 * 0 none, 1 the sixteen ANSI colours, 2 twenty-four bit. The brand palette only
 * survives intact at level 2; below that every shade collapses onto the nearest
 * basic colour, which is why nothing here encodes meaning in shade alone.
 */
export const colourDepth: 0 | 1 | 2 = !useColour
  ? 0
  : /truecolor|24bit/i.test(process.env.COLORTERM ?? '')
    ? 2
    : 1

const ESC = '\x1b['
const wrap = (code: string) => (s: string) => (useColour ? `${ESC}${code}m${s}${ESC}0m` : s)

/** Truecolour when the terminal has it, otherwise the supplied fallback. */
export const rgb =
  (r: number, g: number, b: number, fallback: (s: string) => string = (s) => s) =>
  (s: string) =>
    colourDepth === 2 ? `${ESC}38;2;${r};${g};${b}m${s}${ESC}0m` : fallback(s)

export const c = {
  dim: wrap('2'),
  bold: wrap('1'),
  green: wrap('32'),
  yellow: wrap('33'),
  red: wrap('31'),
  cyan: wrap('36'),
  /** The one accent from the marketing site, reserved for live things. */
  signal: rgb(0x3f, 0xe0, 0x8b, wrap('32')),
  grey: rgb(0x6b, 0x72, 0x80, wrap('2')),
}

export const cursor = {
  // Cursor controls are terminal capabilities, not colour capabilities. The
  // progress UI writes to stderr, so stdout may be piped to jq while stderr is
  // still an interactive terminal that needs its cursor restored.
  hide: () => `${ESC}?25l`,
  show: () => `${ESC}?25h`,
  up: (n: number) => `${ESC}${n}A`,
  clearLine: () => `\r${ESC}2K`,
  clearBelow: () => `${ESC}0J`,
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
// SGR is what Fleet emits today, but accept all CSI sequences so a value that
// arrives already decorated by a caller cannot make width accounting drift.
// OSC covers terminal hyperlinks, which are zero-width too.
const ANSI = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\))/g

const isZeroWidth = (code: number): boolean =>
  (code >= 0x0300 && code <= 0x036f) ||
  (code >= 0x1ab0 && code <= 0x1aff) ||
  (code >= 0x1dc0 && code <= 0x1dff) ||
  (code >= 0x20d0 && code <= 0x20ff) ||
  (code >= 0xfe00 && code <= 0xfe0f) ||
  (code >= 0xfe20 && code <= 0xfe2f) ||
  code === 0x200d

/** A pragmatic terminal-cell width for the CLI's labels and progress lines. */
const cellWidth = (grapheme: string): number => {
  const points = [...grapheme].map((char) => char.codePointAt(0)!)
  if (!points.length || points.every(isZeroWidth)) return 0

  // Emoji presentation and common wide East Asian ranges occupy two cells in
  // mainstream terminals. A grapheme stays one unit here, so ZWJ emoji do not
  // accidentally count once per constituent code point.
  if (
    points.some((code) =>
      code >= 0x1f000 ||
      (code >= 0x1100 && code <= 0x115f) ||
      (code >= 0x2e80 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xff01 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6)
    )
  ) return 2
  return 1
}

const graphemes = (text: string): string[] => {
  // Segmenter prevents a truncation point from splitting an emoji, accent, or
  // other user-visible character. The fallback remains correct enough on old
  // Node versions: it only loses the nicer grapheme boundary.
  const Segmenter = Intl.Segmenter
  return Segmenter
    ? [...new Segmenter().segment(text)].map((part) => part.segment)
    : [...text]
}

const visibleLength = (s: string) =>
  graphemes(s.replace(ANSI, '')).reduce((width, grapheme) => width + cellWidth(grapheme), 0)

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

/**
 * Cut to a visible width, stepping over colour codes rather than counting them.
 * Anything that redraws in place depends on this: a line that wraps occupies two
 * terminal rows, and the cursor arithmetic above it silently goes wrong.
 */
export function truncate(text: string, width: number): string {
  const limit = Math.max(1, width)
  if (visibleLength(text) <= limit) return text

  let out = ''
  let visible = 0
  let hasSgr = false
  for (let i = 0; i < text.length; i++) {
    const escape = text.slice(i).match(/^\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\))/)
    if (escape) {
      out += escape[0]
      hasSgr ||= /^\x1b\[[0-9;]*m$/.test(escape[0])
      i += escape[0].length - 1
      continue
    }
    const [grapheme] = graphemes(text.slice(i))
    const cells = cellWidth(grapheme!)
    if (visible + cells > limit - 1) break
    out += grapheme
    i += grapheme!.length - 1
    visible += cells
  }
  return `${out}…${hasSgr ? `${ESC}0m` : ''}`
}

export { visibleLength }

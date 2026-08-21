/**
 * The Fleet mark, drawn in the terminal: eight peers around one live hub — the
 * same topology as the mesh on the marketing site, so the CLI and the browser
 * are recognisably the same product.
 *
 * The mark is a fixed character grid rather than a string per state, because
 * the loading animation lights individual spokes and needs to address cells.
 */
import { c, colourDepth, rgb } from './render.js'

const GRID = [
  '  ○     ○     ○  ',
  '   ╲    │    ╱   ',
  '○───────◉───────○',
  '   ╱    │    ╲   ',
  '  ○     ○     ○  ',
]

export const MARK_WIDTH = 17
export const MARK_HEIGHT = GRID.length

/** Where the hub sits. Always lit — a fleet with no control plane is not a fleet. */
const HUB: Cell = [2, 8]

type Cell = [row: number, col: number]

/** Each peer owns its node glyph and the spoke connecting it to the hub. */
const PEERS: Cell[][] = [
  [[0, 2], [1, 3]],
  [[0, 8], [1, 8]],
  [[0, 14], [1, 13]],
  [[2, 0], [2, 1], [2, 2], [2, 3], [2, 4], [2, 5], [2, 6], [2, 7]],
  [[2, 16], [2, 15], [2, 14], [2, 13], [2, 12], [2, 11], [2, 10], [2, 9]],
  [[4, 2], [3, 3]],
  [[4, 8], [3, 8]],
  [[4, 14], [3, 13]],
]

export const PEER_COUNT = PEERS.length

const key = ([row, col]: Cell) => `${row}:${col}`

/**
 * Brightness 1 is fully lit, 0 is the resting state. Intermediate values only
 * read as a gradient on truecolour terminals; elsewhere anything lit at all
 * takes the accent, which keeps the animation legible rather than uniform.
 */
function shade(glyph: string, brightness: number): string {
  if (brightness <= 0.02) return c.grey(glyph)
  if (colourDepth < 2) return brightness > 0.45 ? c.signal(glyph) : c.grey(glyph)

  // Resting slate → signal green, so a spoke appears to charge rather than blink.
  const t = Math.min(1, brightness)
  const r = Math.round(0x4b + (0x3f - 0x4b) * t)
  const g = Math.round(0x52 + (0xe0 - 0x52) * t)
  const b = Math.round(0x5d + (0x8b - 0x5d) * t)
  return rgb(r, g, b)(glyph)
}

/**
 * Render the mark with a travelling pulse. `phase` advances continuously; peers
 * light in sequence and decay behind the head, so the mark reads as traffic
 * moving through a mesh rather than as a spinner wearing a costume.
 */
export function markFrame(phase: number): string[] {
  const brightness = new Map<string, number>()
  // A negative phase is the resting mark: hub live, peers quiet.
  const resting = !(phase >= 0)

  for (let i = 0; resting === false && i < PEERS.length; i++) {
    // Distance from the pulse head, wrapped, so the trail crosses the seam.
    const raw = (phase - i + PEERS.length) % PEERS.length
    const distance = Math.min(raw, PEERS.length - raw)
    const level = Math.max(0, 1 - distance / 2.4)

    for (const [index, cell] of PEERS[i]!.entries()) {
      // Along a spoke the outer end burns brightest, so the glow reads as
      // arriving at the peer rather than washing the whole edge at once.
      const along = PEERS[i]!.length > 2 ? 1 - index / PEERS[i]!.length : 1
      brightness.set(key(cell), Math.max(brightness.get(key(cell)) ?? 0, level * along))
    }
  }

  return GRID.map((line, row) =>
    [...line]
      .map((glyph, col) => {
        if (glyph === ' ') return glyph
        if (row === HUB[0] && col === HUB[1]) return c.bold(c.signal(glyph))
        return shade(glyph, brightness.get(`${row}:${col}`) ?? 0)
      })
      .join('')
  )
}

/** The resting mark: hub live, peers quiet. */
export const mark = (): string[] => markFrame(-1)

const WORDMARK = ['█▀▀ █   █▀▀ █▀▀ ▀█▀', '█▀  █   █▀  █▀   █ ', '▀   ▀▀▀ ▀▀▀ ▀▀▀  ▀ ']

/**
 * Mark and wordmark side by side, with the tagline tucked under the wordmark so
 * the block stays rectangular. Falls back to a single line when the terminal is
 * too narrow to hold both without wrapping — a wrapped logo looks broken.
 */
export function banner(subtitle?: string): string {
  // `columns` is 0, not undefined, on some pseudo-terminals — `??` would miss it.
  const columns = process.stdout.columns || 80
  if (columns < 46) return `${c.signal('◉')} ${c.bold('fleet')}${subtitle ? c.dim(`  ${subtitle}`) : ''}`

  // The wordmark sits against the middle three rows of the mark; the tagline
  // takes the last. Every mark row is exactly MARK_WIDTH visible columns, so a
  // fixed gutter aligns them without measuring around the colour codes.
  const right = ['', ...WORDMARK.map(c.bold), subtitle ? c.dim(subtitle) : '']

  return mark()
    .map((line, i) => `  ${line}${right[i] ? `    ${right[i]}` : ''}`.trimEnd())
    .join('\n')
}

/**
 * A progress ladder: several named steps sharing one redraw region, each
 * settling in place as it completes.
 *
 * This exists because a stack of independent spinners cannot answer the only
 * question an operator has during a four-minute deploy — where am I. Completed
 * steps stay on screen, the active step carries the clock, and the steps still to
 * come are listed from the start, so the shape of the whole operation is legible
 * before it has finished.
 *
 * The two rules from ui.ts still hold. Everything here goes to stderr, so `--json`
 * on stdout stays pipeable into jq. And every animated form has a plain-line
 * transcript equivalent, so a CI log reads as a sequence of events rather than as
 * a smear of cursor escapes.
 */
import { c, cursor, glyphs, truncate } from './render.js'
import { MARK_HEIGHT, markFrame, PEER_COUNT } from './mark.js'
import {
  animated,
  claimRegion,
  duration,
  elapsed,
  glyph,
  hookCursorRestore,
  isQuiet,
  releaseRegion,
  setInterruptHandler,
  tickFor,
  width,
} from './ui.js'

const err = process.stderr

export type Step = { key: string; label: string }

export type Ladder = {
  /** Mark a step in flight. An optional label replaces the one declared up front. */
  begin(key: string, label?: string): void
  /** The volatile line under the active step: which layer, which node, which check. */
  detail(key: string, text: string): void
  done(key: string, summary?: string): void
  skip(key: string, why?: string): void
  fail(key: string, why?: string): void
  /** Fail whichever step is in flight. For unwinding on an exception. */
  failActive(why?: string): void
  /** Settle an aside above the region — a warning, a URL — and carry on. */
  note(line: string): void
  /** Hand the terminal back so something else can prompt on it. */
  suspend(): void
  resume(): void
  close(): void
}

export type LadderOptions = {
  /** Paint the pulsing mesh above the steps. For work that genuinely takes minutes. */
  mark?: boolean
  /** Shown beside the mark. Ignored without it. */
  title?: string
  /**
   * Printed if the operator interrupts while this ladder is live. Killing the CLI
   * does not kill work already running on the control plane, and saying nothing
   * implies that it does.
   */
  onCancel?: string
}

type StepState = 'todo' | 'active' | 'done' | 'skip' | 'fail'

type Row = Step & {
  state: StepState
  summary?: string
  detail?: string
  startedAt?: number
  took?: number
}

/**
 * The live ladder, if there is one. Prompts need to find it in order to step
 * aside for it; threading it through every call site instead would mean every
 * command that can prompt has to know whether it is inside a ladder.
 */
let current: Ladder | null = null
export const activeLadder = (): Ladder | null => current

const screenRows = () => err.rows || process.stdout.rows || 24

export function ladder(steps: Step[], opts: LadderOptions = {}): Ladder {
  const rows: Row[] = steps.map((step) => ({ ...step, state: 'todo' }))
  const at = (key: string) => rows.find((row) => row.key === key)

  // The mark is the first thing to go when the terminal is short: the steps carry
  // the information, the mesh only carries the brand.
  const withMark = Boolean(opts.mark) && screenRows() >= MARK_HEIGHT + rows.length + 5
  // One spare row for the detail line that appears under the active step.
  const height = (withMark ? MARK_HEIGHT + 1 : 0) + rows.length + 1
  const indent = withMark ? '  ' : ''

  const owner = {}
  // claimRegion mutates, so it stays last: a ladder that is too tall to redraw
  // must not take ownership on its way to the transcript fallback.
  const live = animated() && !isQuiet() && screenRows() >= height + 2 && claimRegion(owner)

  const tick = tickFor(height)
  let ticks = 0
  let phase = 0
  let painted: string[] = []
  let timer: NodeJS.Timeout | undefined
  let closed = false
  let lastTranscriptDetail = 0

  const took = (row: Row) =>
    row.state === 'active' ? elapsed(row.startedAt ?? Date.now()) : duration(row.took ?? 0)

  const render = (row: Row, spin: string): string => {
    const marker =
      row.state === 'active'
        ? c.signal(spin)
        : row.state === 'done'
          ? glyph.ok
          : row.state === 'fail'
            ? glyph.fail
            : glyph.pending
    const dimmed = row.state === 'todo' || row.state === 'skip'
    const label = dimmed ? c.dim(row.label) : row.label
    const summary = row.summary ? `  ${c.dim(row.summary)}` : ''
    return `${marker} ${label}${summary}${took(row)}`
  }

  const frame = (): string[] => {
    const spin = glyphs.frames[ticks % glyphs.frames.length]!
    const body = rows.flatMap((row) => {
      const out = [`${indent}${render(row, spin)}`]
      if (row.state === 'active' && row.detail)
        out.push(`${indent}  ${c.dim(`${glyphs.branch} ${row.detail}`)}`)
      return out
    })
    const head = withMark
      ? [
          ...markFrame(phase).map(
            (line, i) => `  ${line}${i === 2 && opts.title ? `    ${c.bold(opts.title)}` : ''}`
          ),
          '',
        ]
      : []
    return [...head, ...body].map((line) => truncate(line, width()))
  }

  /**
   * Rewrite only the rows that moved, batched into a single write. A full repaint
   * of a nine-row region twelve times a second is visible as flicker over SSH,
   * and most frames change one row.
   */
  const paint = (lines: string[]) => {
    if (!lines.length) return
    if (painted.length !== lines.length) {
      // The row count changed, so a partial rewrite would orphan rows below.
      err.write(
        (painted.length ? cursor.up(painted.length) + '\r' + cursor.clearBelow() : '') +
          lines.join('\n') +
          '\n'
      )
      painted = lines
      return
    }

    let first = -1
    let last = -1
    for (let i = 0; i < lines.length; i++) {
      if (lines[i] !== painted[i]) {
        if (first < 0) first = i
        last = i
      }
    }
    // Nothing moved: leave the terminal completely alone.
    if (first < 0) return

    let out = cursor.up(lines.length - first)
    for (let i = first; i <= last; i++) {
      if (lines[i] !== painted[i]) out += cursor.clearLine() + lines[i]
      out += '\n'
    }
    // Back to where the region ends, without a newline that could scroll it.
    const below = lines.length - 1 - last
    if (below > 0) out += cursor.down(below)
    err.write(out)
    painted = lines
  }

  const erase = () => {
    if (!painted.length) return
    err.write(cursor.up(painted.length) + '\r' + cursor.clearBelow())
    painted = []
  }

  const advance = () => {
    ticks += 1
    // Scale the pulse by the tick so it travels at the same speed on a slow link.
    phase = (phase + 0.25 * (tick / 80)) % PEER_COUNT
    paint(frame())
  }

  const start = () => {
    timer = setInterval(advance, tick)
    timer.unref?.()
  }

  /** One transcript line per transition — the same rule the spinner follows. */
  const transcript = (line: string) => {
    if (!isQuiet()) err.write(`${line}\n`)
  }

  const api: Ladder = {
    begin(key, label) {
      const row = at(key)
      if (!row) return
      if (label) row.label = label
      row.state = 'active'
      row.startedAt = Date.now()
      row.detail = undefined
      if (live) paint(frame())
      else transcript(`${c.dim(glyphs.stepActive)} ${row.label}…`)
    },

    detail(key, text) {
      const row = at(key)
      if (!row || row.state !== 'active' || row.detail === text) return
      row.detail = text
      if (live) {
        paint(frame())
        return
      }
      // Without a redraw region every sub-step would be its own line, and a build
      // emits hundreds. Keep a captured log alive without flooding it.
      if (Date.now() - lastTranscriptDetail < 10_000) return
      lastTranscriptDetail = Date.now()
      transcript(`  ${c.dim(`${glyphs.branch} ${text}`)}`)
    },

    done(key, summary) {
      const row = at(key)
      if (!row) return
      row.took = Date.now() - (row.startedAt ?? Date.now())
      row.state = 'done'
      row.summary = summary
      row.detail = undefined
      if (live) paint(frame())
      else transcript(`${glyph.ok} ${row.label}${summary ? ` — ${summary}` : ''}${took(row)}`)
    },

    skip(key, why) {
      const row = at(key)
      if (!row) return
      row.state = 'skip'
      row.summary = why ?? 'skipped'
      row.detail = undefined
      if (live) paint(frame())
      else transcript(`${glyph.pending} ${c.dim(`${row.label} — ${row.summary}`)}`)
    },

    fail(key, why) {
      const row = at(key)
      if (!row) return
      row.took = Date.now() - (row.startedAt ?? Date.now())
      row.state = 'fail'
      row.summary = why
      row.detail = undefined
      if (live) paint(frame())
      else transcript(`${glyph.fail} ${row.label}${why ? ` — ${why}` : ''}${took(row)}`)
    },

    failActive(why) {
      for (const row of rows) if (row.state === 'active') api.fail(row.key, why)
    },

    note(line) {
      if (!live) {
        transcript(line)
        return
      }
      erase()
      err.write(`${line}\n`)
      paint(frame())
    },

    suspend() {
      if (!live) return
      clearInterval(timer)
      erase()
      err.write(cursor.show())
      releaseRegion(owner)
    },

    resume() {
      if (!live || closed || !claimRegion(owner)) return
      err.write(cursor.hide())
      paint(frame())
      start()
    },

    close() {
      if (closed) return
      closed = true
      clearInterval(timer)
      setInterruptHandler(null)
      releaseRegion(owner)
      if (current === api) current = null
      if (!live) return
      erase()
      // Reprint the settled steps as static lines so scrollback keeps the summary.
      // The mesh does not survive: a frozen loading animation in scrollback says
      // nothing that a settled step list does not say better.
      const settled = rows
        .filter((row) => row.state !== 'todo')
        .map((row) => truncate(render(row, glyphs.stepActive), width()))
      err.write((settled.length ? `${settled.join('\n')}\n` : '') + cursor.show())
    },
  }

  if (live) {
    current = api
    hookCursorRestore()
    setInterruptHandler(() => {
      erase()
      if (opts.onCancel) err.write(`${glyph.warn} ${opts.onCancel}\n`)
    })
    err.write(cursor.hide())
    paint(frame())
    start()
  }

  return api
}

/**
 * Run work under a ladder, closing it on either outcome. Whichever step was in
 * flight when the work threw is marked failed, so the transcript shows where it
 * stopped rather than only that it stopped.
 */
export async function withLadder<T>(
  steps: Step[],
  run: (l: Ladder) => Promise<T>,
  opts: LadderOptions = {}
): Promise<T> {
  const l = ladder(steps, opts)
  try {
    return await run(l)
  } catch (error) {
    l.failActive(error instanceof Error ? error.message : undefined)
    throw error
  } finally {
    l.close()
  }
}

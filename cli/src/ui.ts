/**
 * Progress reporting.
 *
 * Two rules shape everything here. Animation goes to stderr, so `--json` on
 * stdout stays pipeable into jq. And every animated form has a plain-line
 * fallback, so output captured by CI or a log file reads as a transcript rather
 * than as a smear of cursor escapes.
 */
import { c, cursor, glyphs, truncate, visibleLength } from './render.js'
import { MARK_HEIGHT, markFrame, PEER_COUNT } from './mark.js'

const err = process.stderr

/** `columns` reads 0 on some pseudo-terminals, so `??` is not enough. */
export const width = (): number => Math.max(1, (err.columns || process.stdout.columns || 80) - 1)

/**
 * `--quiet` drops progress entirely: no frames, no settled lines. Errors still
 * print, because a command that failed silently is worse than a noisy one.
 */
let quiet = false
export const setQuiet = (value: boolean): void => {
  quiet = value
}
export const isQuiet = (): boolean => quiet

/**
 * Animate only where it can be erased again. `FLEET_ANIMATION` overrides the
 * detection in both directions for recordings and for terminals the heuristics
 * read wrongly; `FLEET_NO_ANIMATION` keeps working as it always has.
 */
export const animated = (): boolean => {
  if (quiet) return false
  if (process.env.FLEET_ANIMATION === '0') return false
  if (process.env.FLEET_ANIMATION === '1') return true
  return Boolean(err.isTTY) && !process.env.CI && !process.env.FLEET_NO_ANIMATION
}

const FRAMES = glyphs.frames
const TICK = 80

/**
 * Redrawing in place is slower to watch over a long link than locally, and a
 * tall region costs proportionally more per frame. Neither is worth 12 frames a
 * second.
 */
export const tickFor = (height: number): number =>
  process.env.SSH_CONNECTION || process.env.SSH_TTY || height > 10 ? 200 : TICK

export const glyph = {
  ok: c.signal(glyphs.ok),
  fail: c.red(glyphs.fail),
  warn: c.yellow(glyphs.warn),
  info: c.cyan(glyphs.info),
  pending: c.dim(glyphs.pending),
}

/** A duration, shown only once it is long enough to be worth knowing. */
export const duration = (ms: number): string => {
  const seconds = ms / 1000
  return seconds < 2 ? '' : c.dim(` ${seconds.toFixed(seconds < 10 ? 1 : 0)}s`)
}

/** Time since a start point. Ticks up while a step is in flight. */
export const elapsed = (startedAt: number): string => duration(Date.now() - startedAt)

export type Spinner = {
  /** Replace the headline. */
  update(label: string): void
  /**
   * Lines cycled underneath the headline while work is in flight. These say
   * what the operation involves, not what stage it has reached — the CLI cannot
   * see inside a synchronous build, and inventing a stage would be a lie.
   */
  hints(lines: string[]): void
  /** Settle a line above the spinner and carry on. */
  note(line: string): void
  succeed(label?: string): void
  fail(label?: string): void
  stop(): void
}

/**
 * Exactly one thing may own an in-place redraw region at a time. Two writers
 * moving the cursor relative to their own idea of where it is do not produce
 * half-correct output, they produce shredded output — so the second writer stays
 * quiet rather than fighting for the rows.
 */
let regionOwner: object | null = null
export const claimRegion = (owner: object): boolean => {
  if (regionOwner) return false
  regionOwner = owner
  return true
}
export const releaseRegion = (owner: object): void => {
  if (regionOwner === owner) regionOwner = null
}
export const regionActive = (): boolean => regionOwner !== null

/**
 * Run while a ^C is being handled, before the process leaves. This is how the
 * live region gets erased and how a command says what it left running — killing
 * the CLI does not kill a build that is already underway on the control plane,
 * and pretending otherwise is the misleading part.
 */
let onInterrupt: (() => void) | null = null
export const setInterruptHandler = (fn: (() => void) | null): void => {
  onInterrupt = fn
}

let restoreCursorHooked = false
export function hookCursorRestore(): void {
  if (restoreCursorHooked) return
  restoreCursorHooked = true
  // A spinner interrupted by ^C must not leave the cursor hidden in the shell.
  const restore = () => err.write(cursor.show())
  process.on('exit', restore)
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      try {
        onInterrupt?.()
      } catch {
        // A failing teardown must not stop the cursor being restored.
      }
      restore()
      process.exit(signal === 'SIGINT' ? 130 : 143)
    })
  }
}

/** A spinner that reports nothing: `--quiet`, or a region already owned. */
const silentSpinner = (label: string): Spinner => {
  let text = label
  return {
    update: (next) => {
      text = next
    },
    hints: () => {},
    note: () => {},
    succeed: () => {},
    fail: () => {},
    stop: () => {
      void text
    },
  }
}

export function spinner(label: string): Spinner {
  const startedAt = Date.now()
  let text = label
  let hintLines: string[] = []
  let frame = 0
  let timer: NodeJS.Timeout | undefined
  let done = false

  // A ladder already owns the cursor; a second writer would shred both.
  if (quiet || regionActive()) return silentSpinner(label)

  if (!animated()) {
    err.write(`${label}…\n`)
    return {
      update(next) {
        text = next
        err.write(`${next}…\n`)
      },
      hints(lines) {
        hintLines = lines
      },
      note: (line) => err.write(`${line}\n`),
      succeed: (final) => err.write(`${final ?? text} — done\n`),
      fail: (final) => err.write(`${final ?? text} — failed\n`),
      stop: () => {},
    }
  }

  const owner = {}
  claimRegion(owner)
  hookCursorRestore()
  err.write(cursor.hide())

  const draw = () => {
    // A hint every third of a spinner cycle: long enough to read, short enough
    // that the line is visibly alive during a multi-minute build.
    const hint = hintLines.length
      ? hintLines[Math.floor((Date.now() - startedAt) / 3200) % hintLines.length]
      : undefined
    // One write per frame. Clearing and drawing separately doubles the syscalls
    // and can be seen as a flicker on a slow link.
    err.write(
      cursor.clearLine() +
        truncate(
          `${c.signal(FRAMES[frame % FRAMES.length]!)} ${text}${elapsed(startedAt)}` +
            (hint ? c.dim(`  ${hint}`) : ''),
          width()
        )
    )
    frame++
  }

  draw()
  timer = setInterval(draw, TICK)
  timer.unref?.()

  const settle = (mark: string, final?: string) => {
    if (done) return
    done = true
    clearInterval(timer)
    releaseRegion(owner)
    err.write(cursor.clearLine() + `${mark} ${final ?? text}${elapsed(startedAt)}\n` + cursor.show())
  }

  return {
    update: (next) => {
      text = next
      draw()
    },
    hints: (lines) => {
      hintLines = lines
    },
    note: (line) => {
      err.write(cursor.clearLine() + `${line}\n`)
      draw()
    },
    succeed: (final) => settle(glyph.ok, final),
    fail: (final) => settle(glyph.fail, final),
    stop: () => {
      if (done) return
      done = true
      clearInterval(timer)
      releaseRegion(owner)
      err.write(cursor.clearLine() + cursor.show())
    },
  }
}

/** Run work under a spinner, settling it correctly on either outcome. */
export async function task<T>(
  label: string,
  run: (s: Spinner) => Promise<T>,
  opts: { hints?: string[]; done?: (value: T) => string } = {}
): Promise<T> {
  const s = spinner(label)
  if (opts.hints) s.hints(opts.hints)
  try {
    const value = await run(s)
    s.succeed(opts.done?.(value))
    return value
  } catch (error) {
    s.fail()
    throw error
  }
}

/**
 * The full-mark loading screen: the mesh pulses above a status line for the
 * duration of the work. Reserved for the operations that genuinely take minutes
 * — using it for a fast request would just add latency to look busy.
 */
export async function splash<T>(
  label: string,
  run: (s: { update(label: string): void; hints(lines: string[]): void }) => Promise<T>,
  opts: { hints?: string[]; done?: (value: T) => string } = {}
): Promise<T> {
  const rows = process.stdout.rows ?? 24
  // Not enough room to redraw in place means the frames would scroll and stack.
  if (!animated() || rows < MARK_HEIGHT + 4) {
    return task(label, (s) => run(s), opts)
  }

  const startedAt = Date.now()
  let text = label
  let hintLines = opts.hints ?? []
  let phase = 0
  let painted = 0

  hookCursorRestore()
  err.write(cursor.hide())

  const draw = () => {
    if (painted) err.write(cursor.up(painted) + '\r' + cursor.clearBelow())
    const hint = hintLines.length
      ? hintLines[Math.floor((Date.now() - startedAt) / 3200) % hintLines.length]
      : ''
    const lines = [
      ...markFrame(phase).map((line) => `  ${line}`),
      '',
      `  ${c.signal(FRAMES[Math.floor(phase * 2) % FRAMES.length]!)} ${text}${elapsed(startedAt)}`,
      hint ? `    ${c.dim(hint)}` : '',
    ]
    err.write(lines.map((line) => truncate(line, width())).join('\n') + '\n')
    painted = lines.length
    // One peer every four ticks: slow enough to follow the pulse around.
    phase = (phase + 0.25) % PEER_COUNT
  }

  draw()
  const timer = setInterval(draw, TICK)
  timer.unref?.()

  const teardown = () => {
    clearInterval(timer)
    if (painted) err.write(cursor.up(painted) + '\r' + cursor.clearBelow())
    painted = 0
    err.write(cursor.show())
  }

  try {
    const value = await run({
      update: (next) => {
        text = next
      },
      hints: (lines) => {
        hintLines = lines
      },
    })
    teardown()
    err.write(`${glyph.ok} ${opts.done?.(value) ?? text}${elapsed(startedAt)}\n`)
    return value
  } catch (error) {
    teardown()
    err.write(`${glyph.fail} ${text}${elapsed(startedAt)}\n`)
    throw error
  }
}

/** A titled rule, for separating sections of a long report. */
export function rule(label?: string): string {
  const width = Math.min(process.stdout.columns ?? 80, 72)
  if (!label) return c.dim(glyphs.rule.repeat(width))
  const line = glyphs.rule.repeat(Math.max(0, width - visibleLength(label) - 3))
  return `${c.dim(glyphs.rule.repeat(2))} ${c.bold(label)} ${c.dim(line)}`
}

/** A horizontal meter. Used for headroom, where the shape matters more than the number. */
export function bar(fraction: number, width = 12): string {
  const clamped = Math.max(0, Math.min(1, fraction))
  const filled = Math.round(clamped * width)
  const colour = clamped > 0.85 ? c.red : clamped > 0.65 ? c.yellow : c.signal
  return colour(glyphs.barFill.repeat(filled)) + c.dim(glyphs.barEmpty.repeat(width - filled))
}

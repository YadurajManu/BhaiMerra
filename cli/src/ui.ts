/**
 * Progress reporting.
 *
 * Two rules shape everything here. Animation goes to stderr, so `--json` on
 * stdout stays pipeable into jq. And every animated form has a plain-line
 * fallback, so output captured by CI or a log file reads as a transcript rather
 * than as a smear of cursor escapes.
 */
import { c, cursor, truncate, visibleLength } from './render.js'
import { MARK_HEIGHT, markFrame, PEER_COUNT } from './mark.js'

const err = process.stderr

/** `columns` reads 0 on some pseudo-terminals, so `??` is not enough. */
const width = () => Math.max(1, (err.columns || process.stdout.columns || 80) - 1)

/** Animate only where it can be erased again. */
export const animated = (): boolean =>
  Boolean(err.isTTY) && !process.env.CI && !process.env.FLEET_NO_ANIMATION

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
const TICK = 80

export const glyph = {
  ok: c.signal('✔'),
  fail: c.red('✖'),
  warn: c.yellow('▲'),
  info: c.cyan('›'),
  pending: c.dim('·'),
}

/** Elapsed time, shown only once it is long enough to be worth knowing. */
const elapsed = (startedAt: number): string => {
  const seconds = (Date.now() - startedAt) / 1000
  return seconds < 2 ? '' : c.dim(` ${seconds.toFixed(seconds < 10 ? 1 : 0)}s`)
}

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

let restoreCursorHooked = false
function hookCursorRestore() {
  if (restoreCursorHooked) return
  restoreCursorHooked = true
  // A spinner interrupted by ^C must not leave the cursor hidden in the shell.
  const restore = () => err.write(cursor.show())
  process.on('exit', restore)
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      restore()
      process.exit(signal === 'SIGINT' ? 130 : 143)
    })
  }
}

export function spinner(label: string): Spinner {
  const startedAt = Date.now()
  let text = label
  let hintLines: string[] = []
  let frame = 0
  let timer: NodeJS.Timeout | undefined
  let done = false

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

  hookCursorRestore()
  err.write(cursor.hide())

  const clear = () => err.write(cursor.clearLine())

  const draw = () => {
    // A hint every third of a spinner cycle: long enough to read, short enough
    // that the line is visibly alive during a multi-minute build.
    const hint = hintLines.length
      ? hintLines[Math.floor((Date.now() - startedAt) / 3200) % hintLines.length]
      : undefined
    clear()
    err.write(
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
    clear()
    err.write(`${mark} ${final ?? text}${elapsed(startedAt)}\n${cursor.show()}`)
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
      clear()
      err.write(`${line}\n`)
      draw()
    },
    succeed: (final) => settle(glyph.ok, final),
    fail: (final) => settle(glyph.fail, final),
    stop: () => {
      if (done) return
      done = true
      clearInterval(timer)
      clear()
      err.write(cursor.show())
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
  if (!label) return c.dim('─'.repeat(width))
  const line = '─'.repeat(Math.max(0, width - visibleLength(label) - 3))
  return `${c.dim('──')} ${c.bold(label)} ${c.dim(line)}`
}

/** A horizontal meter. Used for headroom, where the shape matters more than the number. */
export function bar(fraction: number, width = 12): string {
  const filled = Math.round(Math.max(0, Math.min(1, fraction)) * width)
  const colour = fraction > 0.85 ? c.red : fraction > 0.65 ? c.yellow : c.signal
  return colour('█'.repeat(filled)) + c.dim('░'.repeat(width - filled))
}

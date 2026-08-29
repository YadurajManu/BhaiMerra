/**
 * Interactive prompts.
 *
 * One implementation each, because four hand-rolled versions of "are you sure"
 * drifted into four different answers to the questions that actually matter: what
 * happens when stdin is not a terminal, whether silence counts as consent, and
 * whether a typed password can end up in the scrollback.
 *
 * Prompts write to stderr, like the rest of the progress UI, so a command that
 * both asks a question and emits `--json` stays pipeable into jq.
 */
import { createInterface } from 'node:readline/promises'
import { c, cursor, glyphs, truncate, unicode } from './render.js'
import { CliError, EXIT } from './api.js'
import { activeLadder } from './ladder.js'
import { glyph, width } from './ui.js'

const err = process.stderr

/** Asking a question needs somewhere to read the answer from and somewhere to show it. */
export const canPrompt = (): boolean => Boolean(process.stdin.isTTY && err.isTTY)

/**
 * A ladder owns the cursor while it is live, so it has to stand down for the
 * duration of a prompt rather than redraw over the question being asked.
 */
async function withTerminal<T>(run: () => Promise<T>): Promise<T> {
  const live = activeLadder()
  live?.suspend()
  try {
    return await run()
  } finally {
    live?.resume()
  }
}

/**
 * A yes/no question.
 *
 * The two policies are deliberately separate knobs, because for the destructive
 * commands they genuinely differ: `fleet deploy` and `fleet down` want Enter to
 * mean *no* at a keyboard — an accidental return should not roll out a build —
 * while a scripted CI step that pipes no stdin should still proceed without
 * needing `--yes`. `ifNoTerminal` defaults to `default` when a caller has no such
 * split, and `fleet rm` sets neither: it refuses both ways.
 */
export async function confirm(
  question: string,
  opts: { default?: boolean; ifNoTerminal?: boolean } = {}
): Promise<boolean> {
  const fallback = opts.default ?? false
  if (!canPrompt()) return opts.ifNoTerminal ?? fallback

  return withTerminal(async () => {
    const rl = createInterface({ input: process.stdin, output: err })
    try {
      const answer = (await rl.question(`  ${question} ${c.dim(fallback ? '[Y/n]' : '[y/N]')} `))
        .trim()
        .toLowerCase()
      if (!answer) return fallback
      return answer === 'y' || answer === 'yes'
    } finally {
      rl.close()
    }
  })
}

/** A free-text answer. Empty input is rejected rather than silently accepted. */
export async function ask(label: string, opts: { hint?: string } = {}): Promise<string> {
  if (!canPrompt())
    throw new CliError(`${label.trim()} is required, and there is no terminal to ask on.`, EXIT.usage)

  return withTerminal(async () => {
    if (opts.hint) err.write(`${c.dim(`  ${opts.hint}`)}\n`)
    const rl = createInterface({ input: process.stdin, output: err })
    try {
      const value = (await rl.question(`  ${c.dim(label.padEnd(18))}`)).trim()
      if (!value) throw new CliError(`${label.trim()} is required.`, EXIT.usage)
      return value
    } finally {
      rl.close()
    }
  })
}

/**
 * The same, with the echo suppressed. A password or token must not survive in the
 * terminal scrollback or in a screen recording, which rules out letting readline
 * echo it and clearing the line afterwards.
 */
export async function askSecret(label: string, opts: { hint?: string } = {}): Promise<string> {
  if (!canPrompt())
    throw new CliError(`${label.trim()} is required, and there is no terminal to ask on.`, EXIT.usage)

  return withTerminal(async () => {
    if (opts.hint) err.write(`${c.dim(`  ${opts.hint}`)}\n`)
    const rl = createInterface({ input: process.stdin, output: err })
    try {
      err.write(`  ${c.dim(label.padEnd(18))}`)
      // The prompt is written directly, then readline's own echo is disabled, so
      // nothing typed after this point reaches the terminal at all.
      const internal = rl as unknown as { _writeToOutput: (s: string) => void }
      internal._writeToOutput = () => {}
      const value = (await rl.question('')).trim()
      err.write('\n')
      if (!value) throw new CliError(`${label.trim()} is required.`, EXIT.usage)
      return value
    } finally {
      rl.close()
    }
  })
}

export type Choice<T> = { label: string; value: T; hint?: string }

const KEY = {
  up: ['\x1b[A', '\x1bOA', 'k'],
  down: ['\x1b[B', '\x1bOB', 'j'],
  enter: ['\r', '\n'],
  cancel: ['\x03', 'q', '\x1b'],
}

/**
 * An arrow-key picker. Callers must check `canPrompt()` first and raise their own
 * error otherwise: the message a script sees when it forgets `--fleet` is part of
 * that command's contract, and this function does not know what it should say.
 */
export async function select<T>(title: string, choices: Choice<T>[]): Promise<T> {
  if (!choices.length) throw new CliError('Nothing to choose from.', EXIT.usage)
  if (!canPrompt()) throw new CliError('No interactive terminal to choose on.', EXIT.usage)

  return withTerminal(
    () =>
      new Promise<T>((resolve) => {
        let index = 0
        let painted = 0
        const pad = Math.max(...choices.map((choice) => choice.label.length))
        const keys = unicode ? '↑↓ move · enter select · q cancel' : 'up/down move, enter select, q cancel'

        const draw = () => {
          const lines = [
            `  ${c.bold(title)}`,
            ...choices.map((choice, i) => {
              const pointer = i === index ? c.signal(glyphs.pointer) : ' '
              const label = i === index ? c.signal(choice.label.padEnd(pad)) : choice.label.padEnd(pad)
              return `  ${pointer} ${label}${choice.hint ? `  ${c.dim(choice.hint)}` : ''}`
            }),
            c.dim(`    ${keys}`),
          ].map((line) => truncate(line, width()))

          err.write(
            (painted ? cursor.up(painted) + '\r' + cursor.clearBelow() : '') +
              lines.join('\n') +
              '\n'
          )
          painted = lines.length
        }

        const stdin = process.stdin
        const wasRaw = Boolean(stdin.isRaw)

        const teardown = () => {
          stdin.off('data', onData)
          stdin.setRawMode?.(wasRaw)
          stdin.pause()
          // `ESC[0A` is read as up-one by most terminals, so an unpainted list
          // must not try to move at all.
          if (painted) err.write(cursor.up(painted) + '\r' + cursor.clearBelow())
          err.write(cursor.show())
          painted = 0
        }

        function onData(chunk: string) {
          // A chunk carries a whole escape sequence, or several keys at once.
          const key = chunk.toString()
          if (KEY.cancel.includes(key)) {
            teardown()
            err.write(`${glyph.pending} ${c.dim('cancelled')}\n`)
            // In raw mode ^C arrives as a byte, not a signal, so the exit code
            // has to be produced here or the shell sees a clean exit.
            process.exit(key === '\x03' ? 130 : EXIT.ok)
          }
          if (KEY.enter.includes(key)) {
            const chosen = choices[index]!
            teardown()
            err.write(`${glyph.ok} ${c.bold(title)}  ${chosen.label}\n`)
            resolve(chosen.value)
            return
          }
          if (KEY.up.includes(key)) index = (index - 1 + choices.length) % choices.length
          else if (KEY.down.includes(key)) index = (index + 1) % choices.length
          else if (/^[1-9]$/.test(key) && Number(key) <= choices.length) index = Number(key) - 1
          else return
          draw()
        }

        err.write(cursor.hide())
        draw()
        stdin.setEncoding('utf8')
        stdin.setRawMode?.(true)
        stdin.on('data', onData)
        stdin.resume()
      })
  )
}

/**
 * Offer a picker when a name did not match, and otherwise raise the error the
 * command would have raised anyway. Used by the three lookups that previously
 * only listed the valid names and left the operator to retype one.
 */
export async function selectOrThrow<T>(
  title: string,
  choices: Choice<T>[],
  error: CliError
): Promise<T> {
  if (!canPrompt() || !choices.length) throw error
  err.write(`${glyph.warn} ${error.message.split('\n')[0]}\n`)
  return select(title, choices)
}

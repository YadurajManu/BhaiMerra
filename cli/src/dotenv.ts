/**
 * Reading a .env file.
 *
 * Deliberately not a general dotenv implementation. This one feeds a
 * credential store, which changes the trade-offs: a value that is silently
 * altered on the way in fails authentication somewhere far away from here,
 * with nothing to point back at this file. So the rules are narrow, and
 * anything ambiguous is reported rather than guessed at.
 */

export type EnvEntry = { key: string; value: string; line: number }

export type EnvFile = {
  entries: EnvEntry[]
  /** Lines that were not a usable assignment, with why. */
  skipped: Array<{ line: number; text: string; reason: string }>
  /** Values that may not be what the author meant. */
  warnings: string[]
}

/** The same shape the control plane accepts as an environment variable name. */
const KEY_PATTERN = /^[A-Z_][A-Z0-9_]{0,127}$/

export function parseDotenv(source: string): EnvFile {
  const entries: EnvEntry[] = []
  const skipped: EnvFile['skipped'] = []
  const warnings: string[] = []
  const seen = new Set<string>()

  const lines = source.split(/\r?\n/)

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!
    const line = i + 1
    const trimmed = raw.trim()

    if (!trimmed || trimmed.startsWith('#')) continue

    // `export FOO=bar` is common in files meant to be sourced by a shell.
    const withoutExport = trimmed.replace(/^export\s+/, '')

    const eq = withoutExport.indexOf('=')
    if (eq < 1) {
      skipped.push({ line, text: trimmed, reason: 'not a KEY=VALUE assignment' })
      continue
    }

    const key = withoutExport.slice(0, eq).trim()
    if (!KEY_PATTERN.test(key)) {
      skipped.push({ line, text: key, reason: 'not a usable environment variable name' })
      continue
    }

    const rest = withoutExport.slice(eq + 1)
    let value: string

    const quote = rest.trimStart()[0]
    if (quote === '"' || quote === "'") {
      const body = rest.trimStart()
      const end = findClosingQuote(body, quote)
      if (end < 0) {
        // A multi-line value, or a typo. Either way, do not guess where it ends.
        skipped.push({ line, text: key, reason: `unterminated ${quote === '"' ? 'double' : 'single'} quote` })
        continue
      }
      const inner = body.slice(1, end)
      // Single quotes are literal, as in a shell. Double quotes take the usual
      // escapes so a value can contain a newline.
      value = quote === "'" ? inner : unescape(inner)
    } else {
      value = rest.trim()
      // A '#' after whitespace is a comment in most dotenv readers and part of
      // the password in some. Truncating a credential is the worse mistake, so
      // this keeps the whole value and says so.
      if (/\s#/.test(value)) {
        warnings.push(
          `${key} (line ${line}) contains " #" and was stored whole, comment included. ` +
            `Quote the value if part of it is a comment.`
        )
      }
    }

    if (seen.has(key)) {
      // Later wins, as a shell would do, but a duplicate is worth saying aloud:
      // two different values for one key is rarely intentional.
      warnings.push(`${key} appears more than once; the value on line ${line} is the one used.`)
      const previous = entries.findIndex((e) => e.key === key)
      entries.splice(previous, 1)
    }
    seen.add(key)
    entries.push({ key, value, line })
  }

  return { entries, skipped, warnings }
}

/** Index of the closing quote, skipping ones that are escaped. */
function findClosingQuote(body: string, quote: string): number {
  for (let i = 1; i < body.length; i++) {
    if (body[i] === '\\' && quote === '"') {
      i++
      continue
    }
    if (body[i] === quote) return i
  }
  return -1
}

function unescape(input: string): string {
  return input.replace(/\\(.)/g, (_, ch: string) => {
    switch (ch) {
      case 'n':
        return '\n'
      case 'r':
        return '\r'
      case 't':
        return '\t'
      case '\\':
        return '\\'
      case '"':
        return '"'
      default:
        return `\\${ch}`
    }
  })
}

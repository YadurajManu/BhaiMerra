import { createHash } from 'node:crypto'

/**
 * Turn a failure into something two failures can be equal by.
 *
 * The explanation for a broken build is expensive once and worthless twice:
 * the same missing lockfile produces the same answer every time, for every
 * user, forever. So an explanation is cached against a signature rather than
 * against a deployment.
 *
 * Everything here exists because a raw log never repeats. Two identical
 * failures differ by their timestamps, their container ids, the digest of the
 * base image they pulled, and how many seconds each step took. Hashing that
 * gives a unique signature every time, the cache never hits, and a feature
 * that should approach zero cost instead charges for every single deploy.
 *
 * The opposite mistake is worse and quieter. Normalise too hard and two
 * genuinely different failures collapse into one signature, so the second gets
 * confidently told about the first one's cause. The rule followed here: strip
 * what identifies an *occurrence*, keep every word that identifies a *problem*.
 * Ports, file names, package names and error text all survive.
 */

/** Log lines to keep. The cause of a build failure is at the end of it. */
export const TAIL_LINES = 40

const RULES: Array<[RegExp, string]> = [
  // Terminal control sequences: colour, cursor movement, progress redraws.
  [/\[[0-9;?]*[A-Za-z]/g, ''],

  // Timestamps, in the shapes build tools actually emit.
  // Separators are ':' in a log line and '_' inside npm's debug-log filename,
  // which is where this one actually appears.
  [/\d{4}-\d{2}-\d{2}[T ]\d{2}[:_]\d{2}[:_]\d{2}(?:[._]\d+)?Z?/gi, '<TS>'],
  [/\b\d{2}:\d{2}:\d{2}(?:\.\d+)?\b/g, '<TS>'],

  // Durations and transfer rates. "took 12.4s" and "took 0.9s" are the same
  // failure; buildx prints one on every line it draws.
  [/\b\d+(?:\.\d+)?\s*(?:ms|s|m|h)\b/g, '<DUR>'],
  [/\b\d+(?:\.\d+)?\s*[KMGT]?i?B(?:\/s)?\b/gi, '<SIZE>'],

  // Identity of this particular run: image digests, container and layer ids.
  [/\bsha256:[0-9a-f]{8,64}\b/gi, '<SHA>'],
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<UUID>'],
  [/\b[0-9a-f]{12,64}\b/gi, '<ID>'],

  // Scratch directories, which carry a fresh random suffix per build.
  [/\/tmp\/[A-Za-z0-9._-]+/g, '/tmp/<TMP>'],
  [/\/var\/folders\/[A-Za-z0-9._\/-]+/g, '/var/folders/<TMP>'],

  // buildx step numbering: "#12 [4/9] RUN npm ci" is the same step whether it
  // is twelfth or fifteenth, and the command after it is the part that matters.
  [/^#\d+\s+/gm, '#<N> '],
  [/\[\s*\d+\/\d+\s*\]/g, '[<STEP>]'],

  // buildx prefixes each line with seconds elapsed and no unit - "0.502" on
  // one run, "2.140" on the next. It is the single largest source of spurious
  // difference between two identical failures, and the duration rule above
  // does not catch it because there is no unit to match.
  [/^#<N> \d+(?:\.\d+)?\s+/gm, '#<N> '],
  [/^\d+\.\d+\s+/gm, ''],

  // Progress percentages and byte counters redrawn on every frame.
  [/\b\d{1,3}(?:\.\d+)?%/g, '<PCT>'],
]

/**
 * A log reduced to what makes this failure the failure it is.
 *
 * Deliberately does NOT touch ports, package names, file names or the words of
 * an error message: "port 8080 already in use" and "port 3000 already in use"
 * are different problems with different fixes, and collapsing them would hand
 * the reader a confident answer about somebody else's deploy.
 */
export function normaliseLog(text: string): string {
  let out = text
  for (const [pattern, replacement] of RULES) out = out.replace(pattern, replacement)

  return out
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n')
    .toLowerCase()
}

/** The last lines of a log, which is where the cause is. */
export function tail(text: string, lines = TAIL_LINES): string {
  const all = text.split('\n')
  return all.slice(Math.max(0, all.length - lines)).join('\n')
}

/**
 * The cache key for a failure.
 *
 * The service name is deliberately not part of it. The same broken lockfile in
 * two different repositories is the same problem with the same fix, and
 * including the name would mean paying for the answer once per service.
 */
export function signatureOf(rawLog: string): string {
  return createHash('sha256').update(normaliseLog(tail(rawLog))).digest('hex').slice(0, 32)
}

/** Whether a failure carries enough to be worth explaining at all. */
export function worthExplaining(rawLog: string | null | undefined): boolean {
  if (!rawLog) return false
  const meaningful = normaliseLog(rawLog)
  // A one-word reason like "drift" or "node_down_pinned" is already the whole
  // explanation; spending a model call to restate it helps nobody.
  return meaningful.length > 40 && meaningful.includes('\n')
}

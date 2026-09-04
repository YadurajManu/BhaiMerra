export type Flags = Record<string, string | boolean>

/**
 * Minimal argument parser: no dependency, and the flag set is small and
 * stable. Lives apart from the entrypoint so it can be tested without the
 * entrypoint running.
 */
export function parseArgs(argv: string[]): { positional: string[]; flags: Flags } {
  const positional: string[] = []
  const flags: Flags = {}

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (!arg.startsWith('-')) {
      positional.push(arg)
      continue
    }
    const name = arg.replace(/^--?/, '')
    const next = argv[i + 1]
    // A flag followed by a non-flag takes it as a value; otherwise boolean.
    if (next !== undefined && !next.startsWith('-')) {
      flags[name] = next
      i++
    } else {
      flags[name] = true
    }
  }
  return { positional, flags }
}

/**
 * Every flag this CLI reads, anywhere.
 *
 * An unknown flag used to be accepted and thrown away, which is how three
 * separate features looked broken in one day: `apply --dry-run` applied,
 * `init --ai` skipped the review, and both read as "the feature does not
 * work" rather than "this build does not have it". A CLI that ignores what
 * you typed is worse than one that refuses it — the refusal is a sentence,
 * the silence is an afternoon.
 *
 * One list rather than a spec per command. It catches the case that actually
 * bites — a flag that does not exist in the installed version, or a typo —
 * without threading a declaration through twenty commands. It does not catch
 * a real flag used on the wrong command; that is a smaller wrong than this.
 */
export const KNOWN_FLAGS = new Set([
  // global
  'fleet', 'api', 'json', 'yes', 'y', 'help', 'h', 'version', 'v', 'no-wait',
  'plan', 'dry-run', 'force',
  // per command
  'ai', 'all', 'channel', 'deploy', 'email', 'events', 'f', 'follow', 'limit',
  'name', 'node', 'only', 'out', 'password', 'secret', 'service', 'sha',
  'since', 'terminal', 'to', 'token', 'url',
])

/** The closest known flag to a mistyped one, or null when nothing is close. */
export function nearestFlag(name: string): string | null {
  if (KNOWN_FLAGS.has(name)) return name

  // A prefix relationship first, because the common mistakes are a flag with
  // something stuck on the end and a flag typed short. `--ai-typo` should
  // suggest `--ai`, which a pure edit distance rates as five changes away and
  // therefore no relation at all.
  let prefixBest: string | null = null
  for (const known of KNOWN_FLAGS) {
    if (known.length < 2) continue
    if (!name.startsWith(known) && !known.startsWith(name)) continue
    if (!prefixBest || Math.abs(known.length - name.length) < Math.abs(prefixBest.length - name.length)) {
      prefixBest = known
    }
  }
  if (prefixBest) return prefixBest

  // Otherwise a transposition or a wrong letter: same length, few differences.
  let best: { flag: string; wrong: number } | null = null
  for (const known of KNOWN_FLAGS) {
    if (Math.abs(known.length - name.length) > 1) continue
    let wrong = Math.abs(known.length - name.length)
    for (let i = 0; i < Math.min(known.length, name.length); i++) {
      if (known[i] !== name[i]) wrong++
    }
    if (!best || wrong < best.wrong) best = { flag: known, wrong }
  }
  return best && best.wrong <= 2 ? best.flag : null
}

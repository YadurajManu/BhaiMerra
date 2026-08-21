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

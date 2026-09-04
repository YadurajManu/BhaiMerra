import { readdir, readFile, stat } from 'node:fs/promises'
import { join, relative } from 'node:path'

/**
 * What a repository says about itself, small enough to read.
 *
 * `discover()` reads a repository with rules and produces a draft. This is the
 * same repository as evidence: the tree, the files that declare dependencies
 * and ports, and the first lines of anything already describing how to run it.
 * The two go together — the draft says what was concluded, this says what it
 * was concluded from, and a reviewer needs both.
 *
 * Deliberately not source code. A manifest is decided by package manifests,
 * Dockerfiles, compose files and entry points; shipping the whole tree would
 * cost tokens, leak more than anyone intended, and bury the three files that
 * actually answer the question.
 */

/** Never read: build output, dependencies, and anything that is not evidence. */
const SKIP = new Set([
  'node_modules', '.git', 'dist', 'build', 'target', 'vendor', '.next', '.nuxt',
  'coverage', '__pycache__', '.venv', 'venv', '.turbo', '.cache', 'tmp', '.DS_Store',
])

/**
 * Files worth quoting, and how much of each.
 *
 * Entry points get a small window because the useful part — a listen() call, a
 * route prefix, a PORT default — is near the top or in the last few lines, and
 * the middle of a server file is business logic nobody needs to see.
 */
const EVIDENCE: Array<{ name: RegExp; lines: number }> = [
  { name: /^package\.json$/, lines: 60 },
  { name: /^(requirements|requirements-prod)\.txt$/, lines: 40 },
  { name: /^(pyproject\.toml|Pipfile|go\.mod|Cargo\.toml|Gemfile)$/, lines: 40 },
  { name: /^Dockerfile(\..+)?$/, lines: 40 },
  { name: /^(docker-)?compose\.ya?ml$/, lines: 60 },
  { name: /^\.env\.(example|sample|template)$/, lines: 40 },
  { name: /^(main|server|app|index)\.(js|ts|mjs|py|go|rb)$/, lines: 40 },
  { name: /^(vite|next|nuxt|astro|svelte)\.config\.(js|ts|mjs)$/, lines: 25 },
  { name: /^README(\.md)?$/, lines: 20 },
]

const MAX_DEPTH = 3
const MAX_TREE_ENTRIES = 300
/** Comfortably inside the endpoint's limit, with room for the draft. */
const MAX_TOTAL_CHARS = 48_000

function windowOf(text: string, lines: number): string {
  const all = text.split('\n')
  if (all.length <= lines) return text.trimEnd()
  // Head and tail: a server file declares its framework at the top and starts
  // listening at the bottom, and the port is usually in the second half.
  const head = all.slice(0, Math.ceil(lines * 0.7)).join('\n')
  const tail = all.slice(-Math.floor(lines * 0.3)).join('\n')
  return `${head}\n…\n${tail}`.trimEnd()
}

/** The tree, breadth-first so the interesting top levels survive the cap. */
async function tree(root: string): Promise<string[]> {
  const out: string[] = []
  let frontier: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }]

  while (frontier.length && out.length < MAX_TREE_ENTRIES) {
    const next: Array<{ dir: string; depth: number }> = []
    for (const { dir, depth } of frontier) {
      let entries
      try {
        entries = await readdir(dir, { withFileTypes: true })
      } catch {
        continue
      }
      for (const e of entries) {
        if (e.name.startsWith('.') && e.name !== '.env.example') continue
        if (SKIP.has(e.name)) continue
        const full = join(dir, e.name)
        const rel = relative(root, full) || e.name
        if (out.length >= MAX_TREE_ENTRIES) break
        out.push(e.isDirectory() ? `${rel}/` : rel)
        if (e.isDirectory() && depth + 1 < MAX_DEPTH) next.push({ dir: full, depth: depth + 1 })
      }
    }
    frontier = next
  }
  return out.sort()
}

/** Build the evidence bundle for a repository root. */
export async function repoMap(root: string = process.cwd()): Promise<string> {
  const paths = await tree(root)

  const sections: string[] = [
    '## Tree',
    paths.join('\n'),
  ]

  let budget = MAX_TOTAL_CHARS - sections.join('\n').length

  for (const rel of paths) {
    if (rel.endsWith('/')) continue
    const base = rel.split('/').pop() ?? rel
    const rule = EVIDENCE.find((e) => e.name.test(base))
    if (!rule) continue

    const full = join(root, rel)
    try {
      const info = await stat(full)
      // A megabyte of lockfile-shaped JSON is not evidence.
      if (info.size > 512 * 1024) continue
      const text = await readFile(full, 'utf8')
      const block = `\n## ${rel}\n${windowOf(text, rule.lines)}`
      // Stop cleanly at the budget rather than sending a truncated file that
      // reads as though the repository itself is malformed.
      if (block.length > budget) break
      sections.push(block)
      budget -= block.length
    } catch {
      // Unreadable is not fatal; it is simply not evidence.
    }
  }

  return sections.join('\n')
}

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
const EVIDENCE: Array<{ name: RegExp; lines: number; tier: number }> = [
  // Tier 1 answers "what is this and what port does it serve" — the two
  // questions the manifest is actually made of.
  { name: /^package\.json$/, lines: 45, tier: 1 },
  { name: /^(requirements|requirements-prod)\.txt$/, lines: 30, tier: 1 },
  { name: /^(pyproject\.toml|Pipfile|go\.mod|Cargo\.toml|Gemfile)$/, lines: 30, tier: 1 },
  { name: /^Dockerfile(\..+)?$/, lines: 30, tier: 1 },
  { name: /^(docker-)?compose\.ya?ml$/, lines: 50, tier: 1 },
  // Tier 2 is where a route prefix or a listen() hides.
  { name: /^(main|server|app|index)\.(js|ts|mjs|py|go|rb)$/, lines: 30, tier: 2 },
  { name: /^(vite|next|nuxt|astro|svelte)\.config\.(js|ts|mjs)$/, lines: 20, tier: 2 },
  { name: /^\.env\.(example|sample|template)$/, lines: 25, tier: 2 },
  // Tier 3 is context, and the first thing to go.
  { name: /^README(\.md)?$/, lines: 15, tier: 3 },
]

const MAX_DEPTH = 3
/**
 * Sized for a model's context, not for the endpoint's limit.
 *
 * A free Groq tier allows 8000 tokens a minute for the whole request. This
 * repository's map came to 25kB — about 6,300 tokens — and with the system
 * prompt and the draft on top the request was 8,901 and refused. Roughly four
 * characters to the token, so 14kB of evidence leaves room for the prompt, the
 * draft, and a reply containing a whole manifest.
 */
const MAX_TOTAL_CHARS = 14_000
/** The tree is orientation, not evidence, and it was a fifth of the budget. */
const MAX_TREE_ENTRIES = 120
const MAX_TREE_CHARS = 2_500

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

  let treeText = paths.join('\n')
  if (treeText.length > MAX_TREE_CHARS) {
    treeText = treeText.slice(0, MAX_TREE_CHARS).split('\n').slice(0, -1).join('\n') + '\n…'
  }

  const sections: string[] = ['## Tree', treeText]
  let budget = MAX_TOTAL_CHARS - sections.join('\n').length

  // Candidates, tagged with which service they belong to.
  //
  // The directory is the unit that matters: a monorepo is several services,
  // and one of them having a README is worth less than another having its
  // Dockerfile. Reading files in path order spent the whole budget inside the
  // first two directories and left the rest of the repository undescribed.
  const candidates = paths
    .filter((rel) => !rel.endsWith('/'))
    .map((rel) => {
      const base = rel.split('/').pop() ?? rel
      const rule = EVIDENCE.find((e) => e.name.test(base))
      return rule ? { rel, rule, dir: rel.includes('/') ? rel.split('/')[0]! : '.' } : null
    })
    .filter((x): x is { rel: string; rule: (typeof EVIDENCE)[number]; dir: string } => x !== null)

  const read = async (c: { rel: string; rule: (typeof EVIDENCE)[number] }) => {
    try {
      const full = join(root, c.rel)
      const info = await stat(full)
      // A megabyte of lockfile-shaped JSON is not evidence.
      if (info.size > 512 * 1024) return null
      const text = await readFile(full, 'utf8')
      return `\n## ${c.rel}\n${windowOf(text, c.rule.lines)}`
    } catch {
      // Unreadable is not fatal; it is simply not evidence.
      return null
    }
  }

  // Tier by tier, and within a tier one file per directory before any
  // directory gets a second. Every service is described before any service is
  // described twice, so trimming costs depth rather than whole services.
  for (const tier of [1, 2, 3]) {
    const inTier = candidates.filter((c) => c.rule.tier === tier)
    const byDir = new Map<string, typeof inTier>()
    for (const c of inTier) {
      byDir.set(c.dir, [...(byDir.get(c.dir) ?? []), c])
    }

    let round = 0
    let placed = true
    while (placed && budget > 0) {
      placed = false
      for (const list of byDir.values()) {
        const c = list[round]
        if (!c) continue
        placed = true
        const block = await read(c)
        if (!block || block.length > budget) continue
        sections.push(block)
        budget -= block.length
      }
      round++
    }
  }

  return sections.join('\n')
}

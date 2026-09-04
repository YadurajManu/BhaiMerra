import { readdir, readFile, access } from 'node:fs/promises'
import { basename, join, relative } from 'node:path'
import { detect, type Detection } from './detect.js'
import { safeDatabaseName } from './dbnames.js'

/**
 * Read a whole repository and say what it deploys.
 *
 * `fleet init` could only ever describe one thing: it looked at the current
 * directory, found one framework, and wrote a manifest with one service. Most
 * repositories worth deploying are not that. They are a web app beside an API,
 * a worker beside both, and a Postgres the three of them share — and every one
 * of those had to be written out by hand, from a spec, by someone who had
 * just arrived.
 *
 * Everything here is deterministic. Workspaces are declared in files that
 * already exist; a dependency on `pg` is a fact, not an inference; and
 * `.env.example` exists precisely to say which variables a service needs. None
 * of this needs a model, and a model would be worse at it: this has to give
 * the same answer twice.
 */

export type DiscoveredService = {
  name: string
  /** Path relative to the repository root, as `build:` will name it. */
  dir: string
  detection: Detection
  /** Variable names from .env.example that look like configuration. */
  env: string[]
  /** Variable names that look like credentials. */
  secrets: string[]
  /** Whether this looks like it wants a GPU, and why. */
  gpu: string | null
  ramMb: number
  /** Engines this service's own dependencies imply. A frontend that never
      talks to Postgres must not claim it does. */
  engines: string[]
}

export type DiscoveredDatabase = { name: string; engine: string; because: string }

export type Discovery = {
  root: string
  /** Which convention declared the workspaces, or null for a single project. */
  layout: string | null
  services: DiscoveredService[]
  databases: DiscoveredDatabase[]
  notes: string[]
}

const exists = async (p: string) => {
  try {
    await access(p)
    return true
  } catch {
    return false
  }
}

const readText = async (p: string): Promise<string> => {
  try {
    return await readFile(p, 'utf8')
  } catch {
    return ''
  }
}

const readJson = async (p: string): Promise<Record<string, unknown> | null> => {
  try {
    return JSON.parse(await readFile(p, 'utf8')) as Record<string, unknown>
  } catch {
    return null
  }
}

/** Directories that are never a service, whatever else they contain. */
const IGNORED = new Set([
  'node_modules', '.git', 'dist', 'build', 'target', 'vendor', '.next',
  'coverage', '__pycache__', '.venv', 'venv', 'tmp', '.turbo', '.cache',
])

/**
 * Dependencies that mean "this service talks to a database".
 *
 * A driver in the dependency list is evidence, not a guess: nobody installs
 * `pg` for a service that does not speak to Postgres.
 */
const DB_HINTS: Array<{ engine: string; deps: string[] }> = [
  {
    engine: 'postgres',
    deps: [
      'pg', 'postgres', 'pg-promise', 'postgres.js', '@prisma/client', 'prisma',
      'typeorm', 'sequelize', 'drizzle-orm', 'knex', 'psycopg2', 'psycopg2-binary',
      'psycopg', 'asyncpg', 'sqlalchemy', 'django', 'lib/pq', 'jackc/pgx', 'sqlx',
      'tokio-postgres', 'diesel',
    ],
  },
  { engine: 'redis', deps: ['redis', 'ioredis', 'redis-py', 'go-redis', 'bull', 'bullmq', 'celery'] },
  { engine: 'mysql', deps: ['mysql', 'mysql2', 'mysqlclient', 'pymysql', 'go-sql-driver'] },
  { engine: 'mongo', deps: ['mongodb', 'mongoose', 'pymongo', 'motor', 'mongo-driver'] },
]

/** Dependencies that mean "this wants a GPU and a lot more memory". */
const GPU_HINTS = [
  'torch', 'pytorch', 'tensorflow', 'transformers', 'vllm', 'accelerate',
  'onnxruntime-gpu', 'jax', 'diffusers', 'sentence-transformers', 'llama-cpp-python',
]

const SECRET_HINT = /(PASSWORD|SECRET|TOKEN|APIKEY|API_KEY|ACCESS_KEY|PRIVATE|CREDENTIAL|_DSN|SALT|CERT|_URL$)/i
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

/** Every dependency name a directory declares, across ecosystems. */
async function dependenciesOf(dir: string): Promise<string[]> {
  const out: string[] = []

  const pkg = await readJson(join(dir, 'package.json'))
  if (pkg) {
    for (const field of ['dependencies', 'devDependencies', 'peerDependencies']) {
      const deps = pkg[field]
      if (deps && typeof deps === 'object') out.push(...Object.keys(deps))
    }
  }

  // Python: one name per line, before any version specifier.
  for (const file of ['requirements.txt', 'requirements-prod.txt', 'pyproject.toml', 'Pipfile']) {
    const text = await readText(join(dir, file))
    for (const line of text.split('\n')) {
      const name = line.trim().split(/[=<>!~\[;#"']/)[0]?.trim()
      if (name && /^[A-Za-z][A-Za-z0-9._-]*$/.test(name)) out.push(name.toLowerCase())
    }
  }

  // Go and Rust name their dependencies as paths and table keys respectively;
  // a substring match on the whole file is enough to spot a driver.
  for (const file of ['go.mod', 'go.sum', 'Cargo.toml']) {
    const text = await readText(join(dir, file))
    if (text) out.push(...text.split('\n').map((l) => l.trim().toLowerCase()))
  }

  return out
}

const mentions = (deps: string[], needle: string) =>
  deps.some((d) => d === needle || d.includes(needle))

/** Variable names a service declares it needs. */
async function envFrom(dir: string): Promise<{ env: string[]; secrets: string[] }> {
  const env: string[] = []
  const secrets: string[] = []

  for (const file of ['.env.example', '.env.sample', '.env.template']) {
    const text = await readText(join(dir, file))
    for (const line of text.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      const key = trimmed.split('=')[0]?.trim()
      if (!key || !ENV_NAME.test(key)) continue
      // A credential and a setting are different things: one belongs in the
      // manifest, the other must never appear in a file anyone commits.
      if (SECRET_HINT.test(key)) secrets.push(key)
      else env.push(key)
    }
  }
  return { env: [...new Set(env)], secrets: [...new Set(secrets)] }
}

/** Workspace globs, from whichever convention this repository uses. */
async function workspaceGlobs(root: string): Promise<{ layout: string; globs: string[] } | null> {
  const pkg = await readJson(join(root, 'package.json'))
  const ws = pkg?.workspaces
  if (Array.isArray(ws)) return { layout: 'npm workspaces', globs: ws.filter((w): w is string => typeof w === 'string') }
  if (ws && typeof ws === 'object' && Array.isArray((ws as { packages?: unknown }).packages)) {
    return { layout: 'yarn workspaces', globs: (ws as { packages: string[] }).packages }
  }

  const pnpm = await readText(join(root, 'pnpm-workspace.yaml'))
  if (pnpm) {
    const globs = pnpm
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.startsWith('- '))
      .map((l) => l.slice(2).replace(/['"]/g, '').trim())
      .filter(Boolean)
    if (globs.length) return { layout: 'pnpm workspace', globs }
  }

  const lerna = await readJson(join(root, 'lerna.json'))
  if (Array.isArray(lerna?.packages)) return { layout: 'lerna', globs: lerna.packages as string[] }

  const goWork = await readText(join(root, 'go.work'))
  if (goWork) {
    const globs = [...goWork.matchAll(/^\s*\.?\/?([\w./-]+)\s*$/gm)]
      .map((m) => m[1]!)
      .filter((p) => p !== 'go' && !p.includes('use') && p !== '.')
    if (globs.length) return { layout: 'go workspace', globs }
  }

  const cargo = await readText(join(root, 'Cargo.toml'))
  const members = cargo.match(/members\s*=\s*\[([^\]]*)\]/)
  if (members) {
    const globs = [...members[1]!.matchAll(/["']([^"']+)["']/g)].map((m) => m[1]!)
    if (globs.length) return { layout: 'cargo workspace', globs }
  }

  return null
}

/**
 * Expand the one glob shape workspaces actually use: a directory then `/*`.
 *
 * Deliberately not a glob library. `apps/*` and `packages/*` are what these
 * files contain in practice, and a dependency to handle the rest is not worth
 * carrying in a CLI whose whole install is one package.
 */
async function expand(root: string, globs: string[]): Promise<string[]> {
  const dirs = new Set<string>()
  for (const glob of globs) {
    if (!glob.includes('*')) {
      if (await exists(join(root, glob))) dirs.add(glob)
      continue
    }
    const base = glob.slice(0, glob.indexOf('*')).replace(/\/$/, '')
    try {
      for (const entry of await readdir(join(root, base), { withFileTypes: true })) {
        if (entry.isDirectory() && !IGNORED.has(entry.name)) dirs.add(join(base, entry.name))
      }
    } catch {
      /* a workspace glob pointing at nothing is the repository's problem */
    }
  }
  return [...dirs]
}

/**
 * Candidate directories for a repository that declares no workspaces.
 *
 * Two shapes, because both are common and neither is declared anywhere. The
 * first is a parent holding many packages - apps/, services/, packages/. The
 * second is simply a few directories at the top level: backend/ beside
 * landing_page/, or api/ beside web/. Looking only for the first meant a
 * perfectly ordinary two-app repository was read as one unrecognised project.
 *
 * Only immediate children are considered. Walking deeper finds vendored
 * copies, fixtures and examples, and proposes deploying them.
 */
async function conventionalDirs(root: string): Promise<string[]> {
  const dirs: string[] = []

  for (const parent of ['apps', 'services', 'packages']) {
    try {
      for (const entry of await readdir(join(root, parent), { withFileTypes: true })) {
        if (entry.isDirectory() && !IGNORED.has(entry.name)) dirs.push(join(parent, entry.name))
      }
    } catch {
      /* not this layout */
    }
  }
  if (dirs.length) return dirs

  try {
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || IGNORED.has(entry.name) || entry.name.startsWith('.')) continue
      dirs.push(entry.name)
    }
  } catch {
    /* unreadable root is the caller's problem */
  }
  return dirs
}

/**
 * Whether a directory is something to deploy.
 *
 * A monorepo is mostly libraries, and a manifest that tries to deploy a shared
 * types package is noise the reader has to delete. Something to run says so:
 * it has a Dockerfile, a start script, or a recognised framework.
 */
async function isDeployable(dir: string, d: Detection): Promise<boolean> {
  if (d.hasDockerfile) return true
  if (d.framework !== 'unknown') {
    const pkg = await readJson(join(dir, 'package.json'))
    if (pkg) {
      const scripts = (pkg.scripts ?? {}) as Record<string, unknown>
      // A package with no way to start is a library, whatever it depends on.
      if (!scripts.start && !scripts.dev && !scripts.serve && d.framework !== 'vite') return false
    }
    return true
  }
  return false
}

const serviceName = (dir: string, root: string): string => {
  const raw = dir === '.' ? basename(root) : basename(dir)
  return raw.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'app'
}

export async function discover(root: string = process.cwd()): Promise<Discovery> {
  const notes: string[] = []

  const ws = await workspaceGlobs(root)
  let candidates: string[] = []
  let layout: string | null = null

  if (ws) {
    layout = ws.layout
    candidates = await expand(root, ws.globs)
    notes.push(`${ws.layout} declares ${candidates.length} package${candidates.length === 1 ? '' : 's'}`)
  } else {
    const conventional = await conventionalDirs(root)
    if (conventional.length) {
      layout = 'directories that look like services'
      candidates = conventional
      notes.push(`no workspace file, but ${conventional.length} directories look like services`)
    }
  }

  // Always consider the root itself: a repository can be a monorepo and still
  // deploy something from its top level.
  if (!candidates.includes('.')) candidates.unshift('.')

  const services: DiscoveredService[] = []
  const allDeps = new Set<string>()

  for (const dir of candidates) {
    const abs = dir === '.' ? root : join(root, dir)
    const d = await detect(abs)
    const deps = await dependenciesOf(abs)
    deps.forEach((x) => allDeps.add(x))

    // Which engines THIS package depends on. Taking the union across the
    // repository made a Next.js frontend declare it uses the database, which
    // is a claim the manifest should not be making on its behalf.
    const ownEngines = DB_HINTS.filter(({ deps: hints }) => hints.some((h) => mentions(deps, h))).map(
      (x) => x.engine
    )

    if (!(await isDeployable(abs, d))) continue
    // A root that only exists to hold workspaces is not a service; without
    // this a monorepo gains a phantom service named after the repository.
    if (dir === '.' && ws && !d.hasDockerfile) continue

    const { env, secrets } = await envFrom(abs)
    const gpu = GPU_HINTS.find((h) => mentions(deps, h)) ?? null

    services.push({
      name: serviceName(dir, root),
      dir: dir === '.' ? '.' : `./${relative(root, abs)}`,
      detection: d,
      env,
      secrets,
      gpu: gpu ? `depends on ${gpu}` : null,
      engines: ownEngines,
      // A model needs room; everything else gets a modest default the reader
      // can lower once they know what it actually uses.
      ramMb: gpu ? 4096 : 512,
    })
  }

  const deps = [...allDeps]
  const databases: DiscoveredDatabase[] = []
  const takenDbNames = new Set<string>()
  for (const { engine, deps: hints } of DB_HINTS) {
    const hit = hints.find((h) => mentions(deps, h))
    // Named `db` and `cache` rather than `postgres` and `redis`: a database
    // named after its engine collides with that engine's own environment
    // variables, and it is not what anyone would write by hand either.
    if (hit) {
      databases.push({
        name: safeDatabaseName(engine, engine, takenDbNames),
        engine,
        because: `something depends on ${hit}`,
      })
    }
  }

  if (!services.length) {
    notes.push('nothing deployable found — no Dockerfile, and no framework this recognises')
  }
  for (const db of databases) notes.push(`${db.engine}: ${db.because}`)

  return { root, layout, services, databases, notes }
}

/** Render a discovery as a manifest. */
export function manifestFromDiscovery(
  d: Discovery,
  opts: { fleet?: string; node?: string } = {}
): { manifest: string; questions: string[] } {
  const questions: string[] = []
  const fleet = opts.fleet ?? 'homelab'
  const lines = [`fleet: ${fleet}`, '', 'services:']

  d.services.forEach((s, i) => {
    if (i) lines.push('')
    lines.push(`  ${s.name}:`)
    lines.push(`    build: ${s.dir}`)
    lines.push('    placement: flexible')
    if (s.detection.port !== 80) lines.push(`    container_port: ${s.detection.port}`)
    lines.push(`    resources: { ram: ${s.ramMb}Mi, cpu: 0.5 }`)
    // Only where the framework genuinely answers at the path. A guessed one
    // that is wrong does not fall back to "no check" — it fails for ever and
    // the deploy never leaves "deploying", while the service runs correctly.
    if (s.detection.healthPath) {
      lines.push(`    health: { path: ${s.detection.healthPath} }`)
    } else {
      lines.push('    # No health check: container state decides whether this')
      lines.push('    # is up. Add one once you know a path that returns 2xx —')
      lines.push('    #   health: { path: /healthz }')
      lines.push('    # Note the probe runs from the node, not inside the')
      lines.push('    # container, so the image needs nothing installed for it.')
    }
    if (s.gpu) {
      lines.push('    gpu: true')
      questions.push(`${s.name}: ${s.gpu}, so it asks for a GPU — remove "gpu: true" if it runs on CPU.`)
    }
    if (s.env.length) {
      lines.push('    env:')
      for (const key of s.env) lines.push(`      ${key}: ""   # from .env.example`)
    }
    if (s.secrets.length) lines.push(`    secrets: [${s.secrets.join(', ')}]`)
    const mine = d.databases.filter((db) => s.engines.includes(db.engine))
    if (mine.length) lines.push(`    uses: [${mine.map((db) => db.name).join(', ')}]`)
  })

  if (d.databases.length) {
    lines.push('', 'databases:')
    d.databases.forEach((db, i) => {
      if (i) lines.push('')
      lines.push(`  ${db.name}:`)
      lines.push(`    engine: ${db.engine}`)
      if (opts.node) lines.push(`    node: ${opts.node}`)
      else {
        lines.push('    node: CHANGE_ME')
        questions.push(`${db.name}: a database must name the node that holds its data — replace CHANGE_ME, or re-run with --node.`)
      }
      lines.push('    backup: daily')
    })
  }

  return { manifest: lines.join('\n') + '\n', questions }
}

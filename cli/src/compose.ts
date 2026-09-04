import { parse as parseYaml } from 'yaml'
import { safeDatabaseName } from './dbnames.js'
import { injectedUrl, pointsAt } from './dburl.js'

/**
 * docker-compose.yml → fleet.yaml.
 *
 * Most people arriving with "different languages, different databases, more
 * services" already have a compose file, and it already states the things a
 * manifest needs: images, ports, environment, volumes, dependencies. Turning
 * that into a manifest is a transform, not a guess — no model, no API key, and
 * the same input always produces the same output.
 *
 * The one place it is more than a rename is databases. A compose file runs
 * `postgres:16` as just another container you are responsible for; Fleet has a
 * managed engine for exactly that, which handles the volume, the data
 * directory, credentials and backups. Translating those literally would work
 * and would throw away the reason to use Fleet, so recognised engine images
 * become `databases:` entries instead.
 *
 * Nothing here invents values. Where compose does not say something Fleet
 * needs — which node holds a database's data, most often — it is reported as
 * a question rather than filled in with a plausible-looking default.
 */

export type ComposeResult = {
  /** The manifest, ready to write or paste. */
  manifest: string
  /** Decisions worth knowing about, in the order they were made. */
  notes: string[]
  /** Things the file could not answer that a human must. */
  questions: string[]
}

/** Images Fleet manages as databases rather than as plain containers. */
const ENGINE_IMAGES: Record<string, string> = {
  postgres: 'postgres',
  postgis: 'postgres',
  // Postgres by another name. pgvector in particular is what anything doing
  // embeddings runs, and leaving it unrecognised turned a managed database
  // back into a container the reader has to look after themselves.
  pgvector: 'postgres',
  'ankane/pgvector': 'postgres',
  'pgvector/pgvector': 'postgres',
  'supabase/postgres': 'postgres',
  'bitnami/postgresql': 'postgres',
  'timescale/timescaledb': 'postgres',
  mysql: 'mysql',
  mariadb: 'mariadb',
  redis: 'redis',
  valkey: 'redis',
  mongo: 'mongo',
  mongodb: 'mongo',
}

/**
 * Names that mean "this value is a credential".
 *
 * Compose has no notion of a secret, so a password sits in the file as plain
 * text. Copying it into `env` would move a credential into a manifest people
 * commit; these keys become `secrets`, which Fleet injects at deploy time.
 */
const SECRET_HINT = /(PASSWORD|PASSWD|SECRET|TOKEN|APIKEY|API_KEY|ACCESS_KEY|PRIVATE|CREDENTIAL|_DSN|_URI|_URL_AUTH|SALT|CERT)/i

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

type ComposeService = Record<string, unknown>

const asRecord = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null

/** compose accepts both `KEY=value` lists and `{KEY: value}` maps. */
function readEnv(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      if (typeof entry !== 'string') continue
      const eq = entry.indexOf('=')
      if (eq < 0) out[entry] = ''
      else out[entry.slice(0, eq)] = entry.slice(eq + 1)
    }
  } else {
    const map = asRecord(raw)
    if (map) for (const [k, v] of Object.entries(map)) out[k] = v == null ? '' : String(v)
  }
  return out
}

/**
 * "127.0.0.1:8080:80/tcp" → { host: 8080, container: 80 }.
 *
 * Counted from the end because the optional bind address is on the front, so
 * the last two numbers are always the pair that matters.
 */
function readPorts(raw: unknown): { host: number; container: number } | null {
  if (!Array.isArray(raw)) return null
  for (const entry of raw) {
    if (typeof entry === 'number') return { host: entry, container: entry }
    if (typeof entry !== 'string') {
      const obj = asRecord(entry)
      if (obj && typeof obj.target === 'number') {
        return { host: Number(obj.published ?? obj.target), container: obj.target }
      }
      continue
    }
    const parts = entry.split('/')[0]!.split(':').filter(Boolean)
    const nums = parts.map(Number).filter((n) => Number.isFinite(n))
    if (!nums.length) continue
    if (nums.length === 1) return { host: nums[0]!, container: nums[0]! }
    return { host: nums[nums.length - 2]!, container: nums[nums.length - 1]! }
  }
  return null
}

/**
 * The first named volume, plus every mount that was left behind.
 *
 * Both halves are returned because dropping something quietly is the whole
 * problem: a bind mount that disappears is a directory the service expected
 * and will not find, and reporting it only when nothing else matched meant the
 * common case - one real volume beside one bind mount - said nothing at all.
 */
function readVolumes(raw: unknown): { volume: { name: string; path: string } | null; skipped: string[] } {
  const skipped: string[] = []
  let volume: { name: string; path: string } | null = null
  if (!Array.isArray(raw)) return { volume, skipped }

  for (const entry of raw) {
    if (typeof entry !== 'string') {
      const obj = asRecord(entry)
      if (obj?.type === 'volume' && typeof obj.source === 'string' && typeof obj.target === 'string') {
        if (!volume) volume = { name: obj.source, path: obj.target }
        else skipped.push(`${obj.source}:${obj.target}`)
      } else if (obj?.type === 'bind') {
        skipped.push(String(obj.source ?? 'bind mount'))
      }
      continue
    }
    const [source, target] = entry.split(':')
    if (!source || !target) continue
    // A path is a bind mount of the developer's own machine, and means nothing
    // on a node that has never seen that directory.
    if (source.startsWith('.') || source.startsWith('/') || source.startsWith('~')) {
      skipped.push(entry)
      continue
    }
    if (!volume) volume = { name: source, path: target }
    else skipped.push(entry)
  }
  return { volume, skipped }
}

/** compose memory limits are "512m", "2g", or a byte count. */
function readMemory(raw: unknown): string | null {
  if (raw == null) return null
  const s = String(raw).trim().toLowerCase()
  const m = s.match(/^(\d+(?:\.\d+)?)\s*([kmg])?b?$/)
  if (!m) return null
  const n = Number(m[1])
  switch (m[2]) {
    case 'g': return `${Math.round(n * 1024)}Mi`
    case 'm': return `${Math.round(n)}Mi`
    case 'k': return `${Math.max(1, Math.round(n / 1024))}Mi`
    default: return `${Math.max(1, Math.round(n / (1024 * 1024)))}Mi`
  }
}

/** A health path out of a compose healthcheck, when one is discoverable. */
function readHealthPath(raw: unknown): string | null {
  const hc = asRecord(raw)
  if (!hc) return null
  const test = hc.test
  const line = Array.isArray(test) ? test.join(' ') : typeof test === 'string' ? test : ''
  const url = line.match(/https?:\/\/[^\s"']+/)
  if (url) {
    try {
      return new URL(url[0]).pathname || '/'
    } catch {
      return null
    }
  }
  return null
}

const engineFor = (image: string): string | null => {
  const name = image.split('@')[0]!.split(':')[0]!.toLowerCase()
  const bare = name.replace(/^(docker\.io|library)\//, '')
  return ENGINE_IMAGES[bare] ?? ENGINE_IMAGES[bare.split('/').pop() ?? ''] ?? null
}

const versionOf = (image: string): string | null => {
  const tag = image.split('@')[0]!.split(':')[1]
  if (!tag || tag === 'latest') return null
  const major = tag.match(/^(\d+)/)
  return major ? major[1]! : null
}

/** YAML-safe scalar. Quoted unless it is unambiguously a bare word. */
const scalar = (v: string): string =>
  /^[A-Za-z0-9._/-]+$/.test(v) && v !== '' ? v : JSON.stringify(v)

export function composeToFleet(
  source: string,
  opts: { fleet?: string; node?: string } = {}
): ComposeResult {
  const notes: string[] = []
  const questions: string[] = []

  let doc: unknown
  try {
    doc = parseYaml(source)
  } catch (err) {
    throw new Error(`that file is not valid YAML: ${(err as Error).message}`)
  }

  const root = asRecord(doc)
  const servicesRaw = asRecord(root?.services)
  if (!servicesRaw || !Object.keys(servicesRaw).length) {
    throw new Error('no services found — is this a docker-compose file?')
  }

  const fleetName = opts.fleet ?? 'homelab'
  const dbNode = opts.node ?? null

  const services: string[] = []
  const databases: string[] = []
  /** Compose names that became databases, so `depends_on` can point at them. */
  const asDatabase = new Set<string>()
  /** Compose name -> the name the database is declared under, which differs
      whenever the compose name would collide with its engine's own env vars. */
  const dbNames = new Map<string, string>()
  /** Compose name -> engine, so a connection string can be rewritten to it. */
  const dbEngines = new Map<string, string>()
  const takenDbNames = new Set<string>()

  // Databases first, so a service's `uses` can reference one by name.
  for (const [name, raw] of Object.entries(servicesRaw)) {
    const svc = (asRecord(raw) ?? {}) as ComposeService
    const image = typeof svc.image === 'string' ? svc.image : ''
    const engine = image ? engineFor(image) : null
    if (!engine) continue
    asDatabase.add(name)
    // Named here, in the pre-pass, not where the database is rendered: a
    // service declared before it in the file still has to point at the name it
    // ends up with, and the main loop would not know it yet.
    dbNames.set(name, safeDatabaseName(name, engine, takenDbNames))
    dbEngines.set(name, engine)
  }

  for (const [name, raw] of Object.entries(servicesRaw)) {
    const svc = (asRecord(raw) ?? {}) as ComposeService
    const image = typeof svc.image === 'string' ? svc.image : ''
    const env = readEnv(svc.environment)

    if (asDatabase.has(name)) {
      const engine = engineFor(image)!
      const major = versionOf(image)
      const declared = dbNames.get(name)!
      if (declared !== name) {
        notes.push(
          `${name} is declared as "${declared}": a database named after its own engine derives a password secret that collides with the engine's own environment variable, and the manifest is rejected.`
        )
      }
      const lines = [`  ${declared}:`]
      lines.push(`    engine: ${major ? `${engine}@${major}` : engine}`)
      if (dbNode) lines.push(`    node: ${scalar(dbNode)}`)
      else {
        lines.push(`    node: CHANGE_ME`)
        questions.push(
          `${name}: a database must name the node that holds its data. Replace CHANGE_ME with a node name, or re-run with --node.`
        )
      }
      // Compose states these as env; Fleet takes them as fields and manages
      // the credential itself, so they are lifted rather than copied.
      const dbName = env.POSTGRES_DB ?? env.MYSQL_DATABASE ?? env.MARIADB_DATABASE ?? env.MONGO_INITDB_DATABASE
      const dbUser = env.POSTGRES_USER ?? env.MYSQL_USER ?? env.MARIADB_USER ?? env.MONGO_INITDB_ROOT_USERNAME
      if (dbName) lines.push(`    database: ${scalar(dbName)}`)
      if (dbUser) lines.push(`    user: ${scalar(dbUser)}`)
      lines.push(`    backup: daily`)
      databases.push(lines.join('\n'))

      notes.push(
        `${name} became a managed ${engine} database — Fleet owns its volume, credentials and backups, so the password from your compose file is not carried over.`
      )
      continue
    }

    const lines = [`  ${name}:`]

    // build or image, never both: the schema rejects it, and they mean
    // different things.
    if (svc.build != null && !image) {
      const b = asRecord(svc.build)
      const context = typeof svc.build === 'string' ? svc.build : typeof b?.context === 'string' ? b.context : '.'
      lines.push(`    build: ${scalar(context)}`)
    } else if (image) {
      lines.push(`    image: ${scalar(image)}`)
      if (svc.build != null) {
        notes.push(`${name}: compose set both build and image; kept image, because that is what compose would have run.`)
      }
    } else {
      lines.push(`    build: .`)
      questions.push(`${name}: compose named neither an image nor a build context — check the build path.`)
    }

    lines.push('    placement: flexible')

    const ports = readPorts(svc.ports) ?? readPorts(svc.expose)
    if (ports) {
      lines.push(`    port: ${ports.host}`)
      if (ports.container !== ports.host) lines.push(`    container_port: ${ports.container}`)
    }

    const mem = readMemory(
      asRecord(asRecord(asRecord(svc.deploy)?.resources)?.limits)?.memory ?? svc.mem_limit
    )
    const cpus = asRecord(asRecord(asRecord(svc.deploy)?.resources)?.limits)?.cpus ?? svc.cpus
    const ram = mem ?? '512Mi'
    const cpu = cpus != null && Number.isFinite(Number(cpus)) ? Number(cpus) : 0.5
    lines.push(`    resources: { ram: ${ram}, cpu: ${cpu} }`)
    if (!mem) notes.push(`${name}: compose set no memory limit, so 512Mi was assumed — the scheduler needs a number to place against.`)

    const health = readHealthPath(svc.healthcheck)
    lines.push(`    health: { path: ${health ?? '/'} }`)
    if (svc.healthcheck && !health) {
      notes.push(`${name}: its healthcheck is a command Fleet cannot reuse, so health falls back to "/" — set a real path if that is wrong.`)
    }

    const { volume: vol, skipped } = readVolumes(svc.volumes)
    if (vol) lines.push(`    volume: { name: ${scalar(vol.name)}, path: ${scalar(vol.path)} }`)
    if (skipped.length) {
      notes.push(
        `${name}: dropped ${skipped.join(', ')} — a service carries one named volume, and a bind mount of your own machine means nothing on a node.`
      )
    }

    // env vs secrets. A value compose leaves to interpolation is not in the
    // file at all, so it cannot be copied - it becomes a secret to supply.
    const plain: Array<[string, string]> = []
    const secrets: string[] = []
    for (const [k, v] of Object.entries(env)) {
      if (!ENV_NAME.test(k)) {
        notes.push(`${name}: dropped env key "${k}" — not a usable variable name.`)
        continue
      }

      // A connection string aimed at a service that just became a managed
      // database is rewritten to the URL Fleet will actually inject.
      //
      // Left alone it goes one of two wrong ways: copied verbatim, so the app
      // dials `mongo:27017` which no longer exists, or swept into `secrets`
      // because the key matches _URI, so the user is asked to supply a value
      // Fleet already knows. Both deploy cleanly and fail to connect, which is
      // the worst kind of wrong — nothing in the manifest looks suspicious.
      const target = [...dbNames.entries()].find(([composeName]) => pointsAt(v, composeName))
      if (target) {
        const [composeName, fleetName] = target
        const engine = dbEngines.get(composeName)
        const url = engine ? injectedUrl(fleetName, engine) : null
        if (url) {
          plain.push([k, url])
          notes.push(
            `${name}: ${k} now points at the managed ${engine} — it named the compose service "${composeName}", which Fleet runs as "${fleetName}" with a password it generates.`
          )
          continue
        }
      }

      const unresolved = v === '' || /^\$\{?[A-Za-z_]/.test(v)
      if (SECRET_HINT.test(k) || unresolved) secrets.push(k)
      else plain.push([k, v])
    }
    if (plain.length) {
      lines.push('    env:')
      for (const [k, v] of plain) lines.push(`      ${k}: ${scalar(v)}`)
    }
    if (secrets.length) {
      lines.push(`    secrets: [${secrets.join(', ')}]`)
      notes.push(
        `${name}: ${secrets.join(', ')} moved to secrets — set them with \`fleet secret set\`, so no credential lives in this file.`
      )
    }

    // `uses` names databases, not services — the parser rejects anything else
    // with "is not a database in this manifest". compose's depends_on covers
    // both, so it has to be split: the database half becomes `uses`, and the
    // service half is dropped, because Fleet works out deploy order itself
    // rather than taking it from the file.
    const deps = Array.isArray(svc.depends_on)
      ? svc.depends_on.filter((d): d is string => typeof d === 'string')
      : Object.keys(asRecord(svc.depends_on) ?? {})
    const dbDeps = deps.filter((d) => asDatabase.has(d)).map((d) => dbNames.get(d) ?? d)
    const svcDeps = deps.filter((d) => !asDatabase.has(d))
    if (dbDeps.length) lines.push(`    uses: [${dbDeps.join(', ')}]`)
    if (svcDeps.length) {
      notes.push(
        `${name}: depends_on ${svcDeps.join(', ')} was dropped — "uses" declares databases, and Fleet decides deploy order from the manifest rather than being told.`
      )
    }

    const replicas = asRecord(svc.deploy)?.replicas
    if (typeof replicas === 'number' && replicas > 1) lines.push(`    replicas: ${replicas}`)

    services.push(lines.join('\n'))
  }

  // A manifest requires at least one service - "a manifest with no services
  // has nothing to deploy" is the product's rule, not an accident. A compose
  // file that is only databases would otherwise emit an empty `services:` key,
  // which YAML reads as null and the parser rejects with a message about
  // records that explains nothing about what the reader actually did.
  if (!services.length) {
    const only = [...asDatabase].join(', ')
    throw new Error(
      `every service in that file is a database (${only}), and a manifest needs something to deploy. ` +
        `Fleet manages those engines for you — declare them alongside the application that uses them.`
    )
  }

  const out = [`fleet: ${scalar(fleetName)}`, '', 'services:', services.join('\n\n')]
  if (databases.length) out.push('', 'databases:', databases.join('\n\n'))

  return { manifest: out.join('\n') + '\n', notes, questions }
}

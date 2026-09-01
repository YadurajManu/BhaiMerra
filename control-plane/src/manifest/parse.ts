import { parse as parseYaml } from 'yaml'
import { z } from 'zod'
import {
  ENGINES,
  clientEnv,
  expandDatabase,
  prefixFor,
  splitEngine,
  type DatabaseDecl,
} from './databases.js'

/**
 * The fleet.yaml manifest (PRD 7.2, docs/fleet-yaml-spec.md).
 *
 * Validation errors are the first thing most users will see from Fleet OS, so
 * they name the path, the value and the fix rather than dumping a schema.
 */

const QUANTITY = /^(\d+(?:\.\d+)?)(Ki|Mi|Gi|Ti|K|M|G|T)?$/i

/** Accepts "512Mi", "2Gi", "1024" (bare numbers are MB). */
export function parseQuantityMb(input: string | number): number | null {
  if (typeof input === 'number') return Number.isFinite(input) ? Math.round(input) : null
  const match = QUANTITY.exec(input.trim())
  if (!match) return null
  const value = Number(match[1])
  const unit = (match[2] ?? 'M').toLowerCase()
  const factor: Record<string, number> = {
    ki: 1 / 1024, k: 1 / 1000,
    mi: 1, m: 1,
    gi: 1024, g: 1000,
    ti: 1024 * 1024, t: 1_000_000,
  }
  const scale = factor[unit]
  return scale === undefined ? null : Math.round(value * scale)
}

const SERVICE_NAME = /^[a-z0-9]([a-z0-9-]{0,46}[a-z0-9])?$/

/** POSIX environment variable name. Shared by `env:` keys and `secrets:` entries. */
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/

/**
 * Env keys whose value plausibly names a host.
 *
 * The co-location warning matches env values against service names, and
 * without this it fires on `DB_USER: postgres` — a username that happens to
 * equal a service name. A warning that is wrong as often as it is right is
 * one people learn to scroll past.
 */
const HOSTISH_KEY = /(^|_)(HOST|HOSTNAME|ADDR|ADDRESS|SERVER|URL|URI|ENDPOINT)$/i

const quantity = z.union([z.string(), z.number()]).transform((v, ctx) => {
  const mb = parseQuantityMb(v)
  if (mb === null || mb <= 0) {
    ctx.addIssue({
      code: 'custom',
      message: `"${v}" is not a valid size. Use 512Mi, 2Gi, or a plain number of megabytes.`,
    })
    return z.NEVER
  }
  return mb
})

const resources = z
  .object({
    ram: quantity.default(256),
    cpu: z.union([z.string(), z.number()]).default(0.25).transform((v, ctx) => {
      const n = typeof v === 'number' ? v : Number(v)
      if (!Number.isFinite(n) || n <= 0 || n > 256) {
        ctx.addIssue({ code: 'custom', message: `cpu must be a positive number of cores, got "${v}"` })
        return z.NEVER
      }
      return n
    }),
  })
  .prefault({})

const DURATION = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h)?$/i

/**
 * Accepts "5s", "1m", "500ms", or a bare number meaning seconds.
 *
 * Rounded up rather than down: a 500ms timeout that became 0 would mean "no
 * timeout" to Docker, which is the opposite of what was asked for.
 */
export function parseDurationSec(input: string | number): number | null {
  if (typeof input === 'number') return Number.isFinite(input) ? Math.max(1, Math.ceil(input)) : null
  const match = DURATION.exec(input.trim())
  if (!match) return null
  const value = Number(match[1])
  const factor: Record<string, number> = { ms: 1 / 1000, s: 1, m: 60, h: 3600 }
  const scale = factor[(match[2] ?? 's').toLowerCase()]
  if (scale === undefined) return null
  const seconds = value * scale
  return seconds <= 0 ? null : Math.max(1, Math.ceil(seconds))
}

const duration = (fallback: string) =>
  z
    .union([z.string(), z.number()])
    .default(fallback)
    .transform((v, ctx) => {
      const seconds = parseDurationSec(v)
      if (seconds === null) {
        ctx.addIssue({
          code: 'custom',
          message: `"${v}" is not a valid duration. Use 5s, 500ms, 1m, or a plain number of seconds.`,
        })
        return z.NEVER
      }
      return seconds
    })

const healthCheck = z
  .object({
    path: z.string().startsWith('/', 'health.path must start with "/"').default('/'),
    timeout: duration('5s'),
    interval: duration('15s'),
    /**
     * For images with no shell to probe with. A distroless container cannot run
     * a health check, and one it can never pass is worse than none at all.
     */
    disabled: z.boolean().default(false),
  })
  .prefault({})

/**
 * The shape, separate from the cross-field rules. `defaults:` validates
 * against the shape alone — a defaults block that only sets `reclaim` should
 * not be told it needs a build context.
 */
const serviceFields = z
  .object({
    /** Source repository used for push-triggered deploys. */
    repo: z.string().min(1, 'repo must be a repository URL').optional(),
    build: z.string().optional(),
    image: z.string().optional(),
    placement: z.enum(['pinned', 'preferred', 'flexible']).default('flexible'),
    node: z.string().optional(),
    resources,
    arch: z.array(z.enum(['arm64', 'armv7', 'amd64'])).default([]),
    min_reliability: z.enum(['any', 'opportunistic', 'standard', 'high']).default('any'),
    gpu: z.boolean().default(false),
    /**
     * `volume: pgdata` mounts at /data. `volume: { name: pgdata, path: ... }`
     * mounts where the image actually keeps its data, which is what a database
     * needs — the string form is kept because it is what most services want and
     * what every existing manifest says.
     */
    volume: z
      .union([
        z.string(),
        z.object({
          name: z.string().min(1),
          path: z.string().startsWith('/', 'volume.path must be an absolute path').optional(),
        }),
      ])
      .optional(),
    domain: z.string().optional(),
    /** Reachable only by other services on the same node, by name. */
    internal: z.boolean().default(false),
    /** The port the container listens on. Ingress publishes it for you. */
    port: z.number().int().min(1).max(65535).default(8080),
    container_port: z.number().int().min(1).max(65535).optional(),
    health: healthCheck,
    env: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}),
    secrets: z.array(z.string()).default([]),
    replicas: z.number().int().min(1).max(50).default(1),
    /**
     * Managed databases this service connects to.
     *
     * Naming one gets its connection details as environment variables and
     * co-locates this service with it: they resolve each other by name on the
     * node's fleet network, which does not span machines.
     */
    uses: z.array(z.string()).default([]),
    affinity: z.array(z.string()).default([]),
    anti_affinity: z.array(z.string()).default([]),
    tags: z.array(z.string()).default([]),
    reclaim: z.enum(['eager', 'idle', 'manual']).optional(),
  })

const serviceSchema = serviceFields
  .transform((val) => ({
    ...val,
    port: val.container_port ?? val.port,
    // Both spellings of `volume` collapse to a name and an optional path here,
    // so nothing downstream has to know there were two.
    volume: typeof val.volume === 'string' ? val.volume : val.volume?.name,
    volumePath: typeof val.volume === 'string' ? undefined : val.volume?.path,
  }))
  .superRefine((svc, ctx) => {
    if (!svc.build && !svc.image) {
      ctx.addIssue({ code: 'custom', message: 'a service needs either "build" (a path) or "image" (a reference)' })
    }
    if (svc.build && svc.image) {
      ctx.addIssue({ code: 'custom', message: 'set "build" or "image", not both — they mean different things' })
    }
    if (svc.placement === 'pinned' && !svc.node) {
      ctx.addIssue({ code: 'custom', message: 'placement "pinned" requires "node" naming which node to pin to' })
    }
    if (svc.placement === 'flexible' && svc.node) {
      ctx.addIssue({ code: 'custom', message: '"node" only applies to pinned or preferred placement' })
    }
    // Both of these become environment variables, so both have to be legal
    // ones. Caught here rather than at deploy: a name a shell cannot read is a
    // typo, and finding it three minutes into a build is no help to anybody.
    for (const key of Object.keys(svc.env)) {
      if (!ENV_NAME.test(key)) {
        ctx.addIssue({
          code: 'custom',
          message: `env key "${key}" is not a usable environment variable name. Use A-Z, 0-9 and _, not starting with a digit.`,
        })
      }
    }
    for (const name of svc.secrets) {
      if (!ENV_NAME.test(name)) {
        ctx.addIssue({
          code: 'custom',
          message: `secret "${name}" is not a usable environment variable name. Use A-Z, 0-9 and _, not starting with a digit.`,
        })
      }
    }
    if (svc.internal && svc.domain) {
      ctx.addIssue({
        code: 'custom',
        message:
          '"internal" and "domain" contradict each other: one says nothing outside may reach this service, the other publishes it. Remove whichever you did not mean.',
      })
    }
    const duplicated = svc.secrets.filter((name) => name in svc.env)
    if (duplicated.length) {
      ctx.addIssue({
        code: 'custom',
        message: `${duplicated.join(', ')} appears in both "env" and "secrets". The secret wins; remove it from "env" so the file says what happens.`,
      })
    }
  })

/**
 * A managed database.
 *
 * `node` is required and deliberately so: a volume does not follow a service
 * between machines, so a database that is not pinned is a database that can be
 * scheduled away from its own data. Making the user say where it lives is the
 * one decision that cannot be defaulted.
 */
const databaseSchema = z.object({
  engine: z.string().min(1, 'name an engine, such as postgres@16'),
  node: z.string().min(1, 'a database must say which node holds its data'),
  /** The database to create. Defaults to the declaration's own name. */
  database: z.string().min(1).optional(),
  user: z.string().min(1).optional(),
  /**
   * Deliberately not the service `resources` schema.
   *
   * That one carries `.prefault({})`, so `.optional()` on it never yields
   * undefined — every declaration arrived carrying the *service* defaults of
   * 256MB and 0.25 cores, which made "the user did not say" indistinguishable
   * from "the user asked for 256MB" and silently overrode the larger default a
   * database actually wants.
   */
  resources: z
    .object({
      ram: quantity.optional(),
      cpu: z.coerce.number().positive().max(256).optional(),
    })
    .optional(),
})

const manifestSchema = z.object({
  fleet: z.string().min(1, 'the manifest must name the fleet it deploys into'),
  /**
   * What this manifest's services are collectively called.
   *
   * Optional, because most manifests never said one and adding a required key
   * would break every existing file. When it is absent the caller supplies a
   * default — the CLI uses the directory name, the way Compose does.
   */
  project: z
    .string()
    .regex(
      SERVICE_NAME,
      'project names must be lowercase letters, digits and hyphens, and cannot start or end with a hyphen'
    )
    .optional(),
  defaults: serviceFields.partial().optional(),
  /**
   * Databases Fleet runs for you.
   *
   * Two facts differ between deployments — which engine, and which node holds
   * the data. Everything else about running Postgres in a container is the
   * same every time and is derived rather than retyped.
   */
  databases: z.record(z.string(), databaseSchema).optional(),
  services: z.record(z.string(), z.unknown()).refine((v) => Object.keys(v).length > 0, {
    message: 'a manifest with no services has nothing to deploy',
  }),
})

export type ServiceManifest = z.infer<typeof serviceSchema>

export type ParsedManifest = {
  fleet: string
  /** Declared by the manifest, or undefined for the caller to default. */
  project?: string
  services: Array<ServiceManifest & { name: string }>
  /**
   * Databases the manifest declared, so the caller can create the credentials
   * they need. They are already present in `services` as well — this is the
   * record of which of those were generated and what they require.
   */
  databases: DatabaseDecl[]
  warnings: string[]
}

export type ManifestIssue = { path: string; message: string }

export class ManifestError extends Error {
  constructor(readonly issues: ManifestIssue[]) {
    super(`fleet.yaml is not valid:\n${issues.map((i) => `  ${i.path}: ${i.message}`).join('\n')}`)
    this.name = 'ManifestError'
  }
}

/**
 * Parse and validate a fleet.yaml. Throws ManifestError with every problem
 * found, not just the first — fixing a manifest one error per deploy is a
 * miserable loop.
 */
export function parseManifest(source: string, project?: string): ParsedManifest {
  let raw: unknown
  try {
    raw = parseYaml(source)
  } catch (err) {
    throw new ManifestError([{ path: 'fleet.yaml', message: (err as Error).message }])
  }

  if (raw === null || typeof raw !== 'object') {
    throw new ManifestError([{ path: 'fleet.yaml', message: 'the file is empty or is not a YAML mapping' }])
  }

  const top = manifestSchema.safeParse(raw)
  if (!top.success) {
    throw new ManifestError(
      top.error.issues.map((i) => ({ path: i.path.join('.') || 'fleet.yaml', message: i.message }))
    )
  }

  const issues: ManifestIssue[] = []
  const warnings: string[] = []
  const services: ParsedManifest['services'] = []

  /* ── databases become services ──────────────────────────────────
     Expanded before anything is validated, so a generated database is
     checked by exactly the same rules as a hand-written service and
     nothing downstream has to know it was generated. */
  const declared = new Map<string, DatabaseDecl>()
  const generated: Record<string, unknown> = {}

  for (const [name, body] of Object.entries(top.data.databases ?? {})) {
    if (!SERVICE_NAME.test(name)) {
      issues.push({
        path: `databases.${name}`,
        message:
          'database names must be lowercase letters, digits and hyphens, and cannot start or end with a hyphen',
      })
      continue
    }
    if (name in top.data.services) {
      issues.push({
        path: `databases.${name}`,
        message: `there is already a service called "${name}". A database becomes a service, so the two names would collide.`,
      })
      continue
    }

    const { engine, version } = splitEngine(body.engine)
    const spec = ENGINES[engine]
    if (!spec) {
      issues.push({
        path: `databases.${name}.engine`,
        message: `"${body.engine}" is not an engine Fleet manages. Available: ${Object.keys(ENGINES).join(', ')}.`,
      })
      continue
    }

    const decl: DatabaseDecl = {
      name,
      engine,
      version: version ?? spec.defaultVersion,
      node: body.node,
      database: body.database ?? name.replace(/-/g, '_'),
      user: body.user ?? spec.defaultUser,
      ramMb: body.resources?.ram,
      cpu: body.resources?.cpu,
    }
    declared.set(name, decl)
    // Volumes are global to a node, so the project scopes the name. Two
    // clients each with a database called "main" must not land on one volume.
    generated[name] = expandDatabase(decl, top.data.project ?? project ?? 'default')
  }

  for (const [name, body] of Object.entries({ ...generated, ...top.data.services })) {
    if (!SERVICE_NAME.test(name)) {
      issues.push({
        path: `services.${name}`,
        message:
          'service names must be lowercase letters, digits and hyphens, and cannot start or end with a hyphen',
      })
      continue
    }

    // Defaults merge shallowly under the service, so a service can always
    // override the fleet-wide value.
    const merged = { ...(top.data.defaults ?? {}), ...(body as object) }
    const parsed = serviceSchema.safeParse(merged)
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        issues.push({
          path: `services.${name}${issue.path.length ? '.' + issue.path.join('.') : ''}`,
          message: issue.message,
        })
      }
      continue
    }

    services.push({ ...parsed.data, name })
  }

  /* ── uses: → connection env and co-location ─────────────────────
     Applied after validation so the generated values cannot be rejected
     by rules the user did not write, and so `uses` referring to a
     database that does not exist is reported as the mistake it is. */
  const primary = [...declared.keys()][0]
  for (const svc of services) {
    if (!svc.uses.length) continue
    if (declared.has(svc.name)) {
      issues.push({
        path: `services.${svc.name}.uses`,
        message: 'a database cannot use another database',
      })
      continue
    }

    for (const ref of svc.uses) {
      const db = declared.get(ref)
      if (!db) {
        issues.push({
          path: `services.${svc.name}.uses`,
          message: `"${ref}" is not a database in this manifest. Declared: ${[...declared.keys()].join(', ') || 'none'}.`,
        })
        continue
      }
      const spec = ENGINES[db.engine]!
      const injected = clientEnv(db, spec, prefixFor(db.name, db.name === primary))

      // The manifest wins. Someone who wrote DATABASE_URL by hand meant it,
      // and silently replacing it would be the worst kind of magic.
      for (const [key, value] of Object.entries(injected)) {
        if (!(key in svc.env)) svc.env[key] = value
      }

      // A service reaches its database by name on the node's fleet network,
      // and that network does not span machines. Pinning it to the same node
      // is not an optimisation — anywhere else and the hostname does not
      // resolve at all.
      if (svc.placement === 'flexible') {
        svc.placement = 'pinned'
        svc.node = db.node
      } else if (svc.node && svc.node !== db.node) {
        issues.push({
          path: `services.${svc.name}.node`,
          message: `pinned to "${svc.node}" but uses database "${ref}" on "${db.node}". Services resolve a database by name only on the same node.`,
        })
      }
      if (!svc.affinity.includes(ref)) svc.affinity.push(ref)
    }
  }

  if (issues.length) throw new ManifestError(issues)

  // Cross-service checks, once every service is known to be individually valid.
  const names = new Set(services.map((s) => s.name))
  const byName = new Map(services.map((s) => [s.name, s]))
  for (const svc of services) {
    for (const [field, refs] of [['affinity', svc.affinity], ['anti_affinity', svc.anti_affinity]] as const) {
      for (const ref of refs) {
        if (!names.has(ref)) {
          issues.push({
            path: `services.${svc.name}.${field}`,
            message: `"${ref}" is not a service in this manifest`,
          })
        }
        if (ref === svc.name) {
          issues.push({
            path: `services.${svc.name}.${field}`,
            message: `a service cannot have ${field} with itself`,
          })
        }
      }
    }

    // FR-18. A warning, not an error: the user may genuinely mean it, but
    // silently allowing it is how people lose data.
    if (svc.volume && svc.placement === 'flexible') {
      warnings.push(
        `services.${svc.name}: declares volume "${svc.volume}" but placement is flexible. ` +
          `Volumes do not move between machines — pin it to the node holding the data.`
      )
    }
    if (svc.volume && svc.replicas > 1) {
      warnings.push(
        `services.${svc.name}: ${svc.replicas} replicas would share one volume "${svc.volume}", so ` +
          `Fleet will not scale it — two processes writing one data directory corrupt it. ` +
          `It runs as a single copy.`
      )
    }
    if (svc.placement === 'pinned' && svc.replicas > 1) {
      warnings.push(
        `services.${svc.name}: "pinned" names one node, so ${svc.replicas} replicas have nowhere ` +
          `to spread to. It runs as a single copy; use "flexible" or "preferred" to scale it.`
      )
    }
    // Service discovery is per node: a container resolves its neighbours by
    // name on the node's fleet network, and nothing resolves across machines
    // until the mesh lands. So an env value naming another service in this
    // manifest is a dependency, and without affinity the scheduler is free to
    // place the two apart — at which point the name stops resolving at runtime,
    // far away from the file that caused it.
    for (const [key, value] of Object.entries(svc.env)) {
      // Only keys that plausibly name a host. `DB_USER: postgres` is a
      // username that happens to match a service name, and warning about it
      // is how a warning system teaches people to ignore it.
      if (!HOSTISH_KEY.test(key)) continue

      const target = String(value)
      if (!names.has(target) || target === svc.name) continue
      if (svc.affinity.includes(target)) continue

      // Two services pinned to the same node cannot be placed apart, so
      // there is nothing here to warn about.
      const other = byName.get(target)
      if (
        svc.placement === 'pinned' &&
        other?.placement === 'pinned' &&
        svc.node &&
        svc.node === other.node
      ) {
        continue
      }

      warnings.push(
        `services.${svc.name}.env.${key}: points at "${target}", which the scheduler may place on ` +
          `another node — and names only resolve between services on the same one. ` +
          `Add affinity: [${target}] to keep them together.`
      )
    }

    if (svc.gpu && svc.placement === 'flexible' && !svc.arch.length) {
      warnings.push(
        `services.${svc.name}: requires a GPU but names no architecture. ` +
          `Placement will be restricted to whichever nodes report one.`
      )
    }
  }

  if (issues.length) throw new ManifestError(issues)

  return { fleet: top.data.fleet, project: top.data.project, services, databases: [...declared.values()], warnings }
}

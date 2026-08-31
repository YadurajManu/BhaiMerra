import { parse as parseYaml } from 'yaml'
import { z } from 'zod'

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

const healthCheck = z
  .object({
    path: z.string().startsWith('/', 'health.path must start with "/"').default('/'),
    timeout: z.string().default('5s'),
    interval: z.string().default('15s'),
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
    volume: z.string().optional(),
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
    affinity: z.array(z.string()).default([]),
    anti_affinity: z.array(z.string()).default([]),
    tags: z.array(z.string()).default([]),
    reclaim: z.enum(['eager', 'idle', 'manual']).optional(),
  })

const serviceSchema = serviceFields
  .transform((val) => ({
    ...val,
    port: val.container_port ?? val.port,
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

const manifestSchema = z.object({
  fleet: z.string().min(1, 'the manifest must name the fleet it deploys into'),
  defaults: serviceFields.partial().optional(),
  services: z.record(z.string(), z.unknown()).refine((v) => Object.keys(v).length > 0, {
    message: 'a manifest with no services has nothing to deploy',
  }),
})

export type ServiceManifest = z.infer<typeof serviceSchema>

export type ParsedManifest = {
  fleet: string
  services: Array<ServiceManifest & { name: string }>
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
export function parseManifest(source: string): ParsedManifest {
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

  for (const [name, body] of Object.entries(top.data.services)) {
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

  if (issues.length) throw new ManifestError(issues)

  // Cross-service checks, once every service is known to be individually valid.
  const names = new Set(services.map((s) => s.name))
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
        `services.${svc.name}: ${svc.replicas} replicas share one volume "${svc.volume}". ` +
          `Unless the image handles concurrent writers, this will corrupt data.`
      )
    }
    // Service discovery is per node: a container resolves its neighbours by
    // name on the node's fleet network, and nothing resolves across machines
    // until the mesh lands. So an env value naming another service in this
    // manifest is a dependency, and without affinity the scheduler is free to
    // place the two apart — at which point the name stops resolving at runtime,
    // far away from the file that caused it.
    for (const [key, value] of Object.entries(svc.env)) {
      const target = String(value)
      if (!names.has(target) || target === svc.name) continue
      if (svc.affinity.includes(target)) continue
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

  return { fleet: top.data.fleet, services, warnings }
}

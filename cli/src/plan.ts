/**
 * What to deploy, and in what order.
 *
 * `fleet up` used to deploy exactly one service, which meant a stack was four
 * invocations typed in the right order — and getting the order wrong looked
 * like a broken application rather than a sequencing mistake, because an API
 * whose database is not up yet fails its health check like any other outage.
 */
import { parse as parseYaml } from 'yaml'

/**
 * What to call this manifest's services collectively when it does not say.
 *
 * The directory name, which is what Compose does and what a person would
 * answer if asked "which project is this". Normalised to the same shape a
 * service name has to be, so the server never rejects a name it derived.
 */
export function projectNameFor(dir: string): string {
  const base = dir.split('/').filter(Boolean).pop() ?? 'default'
  const slug = base
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/, '')
  return slug || 'default'
}

export type PlannedService = {
  name: string
  /** Build context path, relative to the manifest. Absent for a prebuilt image. */
  build?: string
  affinity: string[]
}

/**
 * Read the manifest the way the control plane will.
 *
 * Deliberately forgiving: the server validates, and this only needs enough
 * structure to decide what to send and when. A manifest that is wrong will be
 * rejected by apply with a proper message before any of this matters.
 */
export function planFromManifest(source: string): PlannedService[] {
  const doc = parseYaml(source) as { services?: Record<string, unknown> } | null
  const services = doc?.services
  if (!services || typeof services !== 'object') return []

  return Object.entries(services).map(([name, raw]) => {
    const body = (raw ?? {}) as { build?: unknown; affinity?: unknown }
    return {
      name,
      build: typeof body.build === 'string' ? body.build : undefined,
      affinity: Array.isArray(body.affinity) ? body.affinity.filter((a) => typeof a === 'string') : [],
    }
  })
}

/**
 * Which secrets the manifest says it needs, and which services want each.
 *
 * A .env holds a mix — half configuration, half credentials — and only the
 * credentials belong in the secret store. The manifest already draws that line
 * by declaring `secrets:`, so importing can honour it rather than asking
 * somebody to re-draw it at the command line.
 */
export function declaredSecrets(source: string): Map<string, string[]> {
  const doc = parseYaml(source) as { services?: Record<string, unknown> } | null
  const services = doc?.services
  const declared = new Map<string, string[]>()
  if (!services || typeof services !== 'object') return declared

  for (const [name, raw] of Object.entries(services)) {
    const body = (raw ?? {}) as { secrets?: unknown }
    if (!Array.isArray(body.secrets)) continue
    for (const key of body.secrets) {
      if (typeof key !== 'string') continue
      declared.set(key, [...(declared.get(key) ?? []), name])
    }
  }
  return declared
}

/**
 * Order services so a dependency is deployed before whatever depends on it.
 *
 * `affinity` is the signal. It means "co-locate", not "depends on", but in
 * practice the two coincide: a service is pinned next to the database it talks
 * to, and it cannot become healthy until that database answers. Using it for
 * ordering is a heuristic, and the cost of it being wrong is one slow retry
 * rather than a failure — the agent's restart policy brings up a container that
 * started too early anyway.
 *
 * Ties keep manifest order, so the file stays the explanation for what happens.
 * A cycle is not an error here: the services involved are emitted in manifest
 * order rather than dropped, because refusing to deploy is a worse answer than
 * deploying in an imperfect order.
 */
export function deployOrder(services: PlannedService[]): string[] {
  const byName = new Map(services.map((s) => [s.name, s]))
  const ordered: string[] = []
  const state = new Map<string, 'visiting' | 'done'>()

  const visit = (name: string) => {
    if (state.get(name) === 'done') return
    // Already on the stack: a cycle. Stop rather than recurse forever; the
    // caller still gets every service, just not in a perfect order.
    if (state.get(name) === 'visiting') return

    const service = byName.get(name)
    if (!service) return // affinity on something not in this manifest

    state.set(name, 'visiting')
    for (const dependency of service.affinity) visit(dependency)
    state.set(name, 'done')
    ordered.push(name)
  }

  for (const service of services) visit(service.name)
  return ordered
}

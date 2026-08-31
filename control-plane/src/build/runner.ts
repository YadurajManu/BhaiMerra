import type { ServiceManifest } from '../manifest/parse.js'

/**
 * One line of "where is this build". Coarse enough to be honest: the step
 * counter and platform come from the builder itself, so nothing here is a guess
 * about how far along a build is.
 */
export type BuildProgress = {
  phase: 'building' | 'pushing'
  step?: number
  ofSteps?: number
  platform?: string
  detail: string
}

export type BuildRequest = {
  /** Overrides the configured workspace root, for a fresh git checkout. */
  contextRoot?: string
  serviceName: string
  buildContext: string
  gitSha: string
  /** Every architecture present among the fleet's eligible nodes (FR-3). */
  platforms: string[]
  registry: string
  /**
   * Called as the build reports progress. Per-request rather than per-runner
   * because the runner is a startup singleton shared by every deploy, so a
   * constructor hook could not tell one deployment's output from another's.
   *
   * Implementations must treat this as fire-and-forget: it runs on the child
   * process's stdout, and a slow or throwing callback would stall the build.
   */
  onProgress?: (progress: BuildProgress) => void
}

export type BuildResult = {
  imageTags: string[]
  digest?: string
  logUrl?: string
  durationMs?: number
}

/**
 * Multi-arch image builds (FR-3, tech doc §3).
 *
 * An interface with one honest implementation. Builds run centrally for v1 so
 * a Pi never has to compile anything; offloading to the most capable node in
 * the fleet is the documented later optimisation.
 */
export interface BuildRunner {
  readonly name: string
  available(): Promise<boolean>
  build(req: BuildRequest): Promise<BuildResult>
}

export class BuildUnavailableError extends Error {
  readonly code = 'build_runner_unavailable'
  constructor(reason: string) {
    super(reason)
    this.name = 'BuildUnavailableError'
  }
}

/** Map the fleet's architectures onto Buildx platform strings. */
export function platformsFor(arches: string[]): string[] {
  const map: Record<string, string> = {
    arm64: 'linux/arm64',
    armv7: 'linux/arm/v7',
    amd64: 'linux/amd64',
  }
  return [...new Set(arches)].map((a) => map[a]).filter((p): p is string => Boolean(p))
}

export function inferCompatibleArches(service: Pick<ServiceManifest, 'arch'>, fleetArches: string[]): string[] {
  return service.arch.length ? service.arch : [...new Set(fleetArches)]
}

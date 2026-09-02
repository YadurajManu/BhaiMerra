import { readFile } from 'node:fs/promises'
import { eq } from 'drizzle-orm'
import { join } from 'node:path'
import type { FastifyBaseLogger, FastifyInstance } from 'fastify'
import { githubRepositories, services } from '../db/schema.js'
import { parseManifest } from '../manifest/parse.js'
import { syncManifest } from '../manifest/sync.js'
import { checkoutRepo } from '../git/checkout.js'
import { authenticatedCloneUrl } from '../github/app.js'
import { installationForRepoInOrg } from '../github/installations.js'
import { normaliseRepo, projectForRepo } from '../github/repo-url.js'
import { deployFromPush } from './deploy.js'
import { dispatchEvent } from '../alerting/dispatch.js'

/**
 * Deploy a repository at one commit.
 *
 * One implementation behind three doors — the per-fleet push webhook, the
 * app-wide push webhook, and the first deploy when somebody imports a repo in
 * the dashboard. They differ only in how they work out *which* repository and
 * commit; what happens next has to be identical, or "it deployed when I pushed
 * but not when I imported" becomes a real bug report.
 *
 * Always call this off the request path. A multi-arch build takes minutes and
 * a webhook sender gives up in seconds.
 */
export type RepoDeploy = {
  fleetId: string
  orgId: string
  gitSha: string
  /** Clone URL to fetch from. */
  sourceUrl: string
  /** Every spelling of the repository, normalised — see repoCandidates. */
  candidates: string[]
  /** The connected-repository row, when the deploy came from one. */
  connected?: typeof githubRepositories.$inferSelect | null
  /** Git ref, when this came from a push. Used only in the failure alert. */
  ref?: string
  /** What to name in a failure alert. */
  subject: string
}

export async function deployRepository(
  app: FastifyInstance,
  spec: RepoDeploy,
  log: FastifyBaseLogger
): Promise<{ deployed: string[] }> {
  const { db } = app.ctx
  const shortSha = spec.gitSha.slice(0, 12)
  let checkout: Awaited<ReturnType<typeof checkoutRepo>> | undefined

  try {
    let remote = spec.sourceUrl
    if (app.ctx.github) {
      try {
        const fullName = normaliseRepo(remote).split('/').slice(-2).join('/')
        // Only this fleet's own org may lend a token to this clone. An
        // unscoped search would happily find a stranger's installation that
        // can reach the repo and check out their private source.
        const installation = await installationForRepoInOrg(app.ctx, app.ctx.github, spec.orgId, fullName)
        if (installation) remote = await authenticatedCloneUrl(app.ctx.github, installation, remote)
      } catch (err) {
        log.warn({ err, repository: spec.sourceUrl }, 'could not obtain a GitHub installation token')
      }
    }

    checkout = await checkoutRepo({
      repoUrl: remote,
      gitSha: spec.gitSha,
      workdir: app.ctx.config.BUILD_WORKDIR,
    })

    // The manifest travels with the code. Applying it before the build lets a
    // single push change resources, routes, or services without a second
    // manual dashboard step.
    const manifestPath = spec.connected?.manifestPath ?? 'fleet.yaml'
    const parsedManifest = parseManifest(
      await readFile(join(checkout.path, manifestPath), 'utf8'),
      projectForRepo(spec.connected?.fullName ?? spec.sourceUrl)
    )

    // A connected repository is enough to bootstrap: services in its manifest
    // inherit its safe, App-authorised clone URL unless they explicitly point
    // at another repository.
    const manifest = spec.connected
      ? {
          ...parsedManifest,
          services: parsedManifest.services.map((service) => ({
            ...service,
            repo: service.repo ?? spec.connected!.cloneUrl,
          })),
        }
      : parsedManifest

    const synced = await syncManifest(
      app.ctx,
      spec.fleetId,
      spec.orgId,
      manifest,
      undefined,
      projectForRepo(spec.connected?.fullName ?? spec.sourceUrl)
    )

    const refreshed = await db.select().from(services).where(eq(services.fleetId, spec.fleetId))
    const toDeploy = refreshed.filter(
      (service) => service.repoUrl && spec.candidates.includes(normaliseRepo(service.repoUrl))
    )

    const deployed: string[] = []
    for (const service of toDeploy) {
      await deployFromPush(app, service, spec.gitSha, checkout.path)
      deployed.push(service.name)
      log.info({ service: service.name, sha: shortSha }, 'repository deploy succeeded')
    }

    log.info({ repository: normaliseRepo(spec.sourceUrl), sha: shortSha, ...synced }, 'fleet.yaml applied')
    return { deployed }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log.error({ err, repository: spec.sourceUrl }, 'repository deploy failed')
    await dispatchEvent(
      app.ctx,
      {
        type: 'deploy.failed',
        fleetId: spec.fleetId,
        at: new Date().toISOString(),
        subject: spec.subject,
        detail: { sha: shortSha, ref: spec.ref ?? 'import', reason: message },
      },
      { log, email: app.ctx.email }
    )
    return { deployed: [] }
  } finally {
    await checkout?.dispose().catch(() => {})
  }
}

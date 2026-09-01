import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import type { FastifyInstance } from 'fastify'
import {
  listInstallations,
  listRepos,
  appIdentity,
  slugMismatch,
  branchHead,
  repoFileExists,
  GitHubError,
} from '../github/app.js'
import { repoCandidates } from '../github/repo-url.js'
import { deployRepository } from './repo-deploy.js'
import {
  claimInstallation,
  countUnclaimed,
  orgInstallations,
  requireOrgInstallation,
} from '../github/installations.js'
import { beginInstall, redeemInstall, installUrl, dashboardReturn } from '../github/install-flow.js'
import { githubRepositories, services } from '../db/schema.js'
import { ApiError } from './errors.js'
import { requireFleetPermission } from './guards.js'
import { publicApiOrigin } from './install.routes.js'

/**
 * The dashboard's GitHub surface: which accounts *this org* has connected, and
 * which repositories those installations can reach.
 *
 * Every route here that touches GitHub resolves its installation through
 * `requireOrgInstallation` first. The App's installation list is global to the
 * App, so an id arriving from a browser means nothing on its own — it has to
 * be matched against what the caller's own org has claimed.
 */
export async function githubRoutes(app: FastifyInstance) {
  const github = () => {
    if (!app.ctx.github) {
      throw new ApiError(
        501,
        'github_not_configured',
        'No GitHub App is configured on this control plane. Set GITHUB_APP_ID and ' +
          'GITHUB_APP_PRIVATE_KEY_PATH to connect repositories.'
      )
    }
    return app.ctx.github
  }

  app.get('/fleets/:fleetId/github/status', { preHandler: requireFleetPermission('service.read') }, async (req) => {
    const webhookBase = publicApiOrigin(req, app.ctx.config)
    if (!app.ctx.github) return { configured: false, webhookBase }

    const claimed = await orgInstallations(app.ctx, req.orgId!)

    // Cross-check against GitHub so an installation removed on their side
    // shows as inactive here instead of failing later, mid-deploy. A failure
    // to reach GitHub is not a reason to hide the org's own connections.
    let live: Awaited<ReturnType<typeof listInstallations>> = []
    let error: string | undefined
    // Reported before anyone clicks: with a mismatched slug the install flow
    // succeeds on GitHub and then connects nothing, which is a miserable thing
    // to debug from the outside.
    let misconfiguredSlug: { configured: string; actual: string } | undefined
    // Installs that reached GitHub but never reached us. See countUnclaimed.
    let unclaimedInstallations = 0
    try {
      live = await listInstallations(app.ctx.github)
      unclaimedInstallations = await countUnclaimed(app.ctx, live.map((i) => String(i.id)))
      const identity = await appIdentity(app.ctx.github)
      if (slugMismatch(app.ctx.github, identity)) {
        misconfiguredSlug = { configured: app.ctx.github.slug!, actual: identity.slug }
      }
    } catch (err) {
      if (!(err instanceof GitHubError)) throw err
      error = err.message
    }

    return {
      configured: true,
      webhookBase,
      clientId: app.ctx.github.clientId ?? null,
      canInstall: Boolean(app.ctx.github.slug),
      error,
      misconfiguredSlug,
      unclaimedInstallations,
      installations: claimed.map((row) => ({
        id: Number(row.installationId),
        account: row.account,
        type: row.accountType,
        suspended: Boolean(row.suspendedAt),
        // Unknown rather than false when GitHub could not be reached.
        active: error ? null : live.some((i) => String(i.id) === row.installationId),
      })),
    }
  })

  /**
   * Start the install flow.
   *
   * Returns a one-shot URL rather than a static link to the App page: the
   * `state` it carries is what lets the callback tell which org asked, and it
   * is the only thing standing between "installed the app" and "claimed an
   * account somebody else installed".
   */
  app.post(
    '/fleets/:fleetId/github/install-url',
    { preHandler: requireFleetPermission('service.create') },
    async (req) => {
      const config = github()
      const { fleetId } = req.params as { fleetId: string }
      const state = await beginInstall(app.ctx, {
        orgId: req.orgId!,
        fleetId,
        userId: req.userId!,
      })
      return { url: installUrl(config, state), expiresInSec: 600 }
    }
  )

  /**
   * Where GitHub sends the browser after an install. Deliberately unauthenticated:
   * it is a redirect target, not an API call, and the `state` nonce carries the
   * identity that a bearer token would have. Nothing here trusts a query
   * parameter except by way of that nonce.
   */
  app.get('/github/setup', async (req, reply) => {
    const query = z
      .object({
        installation_id: z.string().optional(),
        setup_action: z.string().optional(),
        state: z.string().optional(),
      })
      .safeParse(req.query)

    const fail = (reason: string) => reply.redirect(dashboardReturn(app.ctx.config, 'failed', reason))

    if (!query.success) return fail('malformed_callback')
    const { installation_id: installationId, setup_action: action, state } = query.data

    // "request" means the user asked an org owner to approve the install; no
    // installation exists yet, so there is nothing to claim.
    if (action === 'request') return fail('awaiting_owner_approval')
    if (!installationId) return fail('no_installation_id')

    const intent = state ? await redeemInstall(app.ctx, state) : null
    if (!intent) {
      // Either the link expired, or somebody arrived here without starting the
      // flow in Fleet. Both must refuse: the alternative is claiming an
      // installation for whoever happens to open the URL.
      return fail('expired_or_unrecognised_link')
    }

    if (!app.ctx.github) return fail('github_not_configured')

    let account: { login: string; type: string } | undefined
    try {
      const installations = await listInstallations(app.ctx.github)
      account = installations.find((i) => String(i.id) === installationId)?.account
    } catch (err) {
      req.log.error({ err }, 'could not read installations while completing GitHub setup')
      return fail('github_unreachable')
    }
    if (!account) {
      // Almost always one cause: GITHUB_APP_SLUG names a different App than
      // the private key does, so the user installed the wrong App and this one
      // has genuinely never seen the installation. Say that, rather than
      // leaving them to guess.
      try {
        const identity = await appIdentity(app.ctx.github)
        if (slugMismatch(app.ctx.github, identity)) {
          req.log.error(
            { configuredSlug: app.ctx.github.slug, actualSlug: identity.slug, appId: identity.id },
            'GITHUB_APP_SLUG names a different App than GITHUB_APP_ID and the private key'
          )
          return fail('app_slug_mismatch')
        }
      } catch {
        // Fall through to the plainer reason below.
      }
      return fail('installation_not_visible_to_this_app')
    }

    try {
      await claimInstallation(app.ctx, {
        orgId: intent.orgId,
        installationId,
        account: account.login,
        accountType: account.type,
        userId: intent.userId,
      })
    } catch (err) {
      if (err instanceof ApiError) return fail(err.code)
      throw err
    }

    req.log.info({ installationId, account: account.login, orgId: intent.orgId }, 'GitHub installation claimed')
    return reply.redirect(dashboardReturn(app.ctx.config, 'connected'))
  })

  app.get('/fleets/:fleetId/github/catalog', { preHandler: requireFleetPermission('service.read') }, async (req) => {
    const config = github()
    const { installation } = req.query as { installation?: string }

    const claimed = await orgInstallations(app.ctx, req.orgId!)
    if (!claimed.length) {
      throw new ApiError(
        404,
        'no_installation',
        'This organisation has not connected a GitHub account yet. Connect one, choosing the ' +
          'repositories Fleet OS may read.'
      )
    }

    // An explicit id is checked against the org's claims; the default is the
    // org's own most recent connection, never the App's global first.
    const target = installation
      ? await requireOrgInstallation(app.ctx, req.orgId!, installation)
      : claimed[0]!

    const repos = await listRepos(config, Number(target.installationId))
    return {
      installation: { id: Number(target.installationId), account: target.account },
      repos: repos
        .map((r) => ({
          fullName: r.full_name,
          cloneUrl: r.clone_url,
          private: r.private,
          defaultBranch: r.default_branch,
          updatedAt: r.updated_at,
        }))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    }
  })

  /** Repositories this fleet has deliberately opted into deploying. */
  app.get(
    '/fleets/:fleetId/github/repositories',
    { preHandler: requireFleetPermission('service.read') },
    async (req) => {
      const { fleetId } = req.params as { fleetId: string }
      const repos = await app.ctx.db
        .select()
        .from(githubRepositories)
        .where(eq(githubRepositories.fleetId, fleetId))
      const fleetServices = await app.ctx.db.select().from(services).where(eq(services.fleetId, fleetId))
      return {
        repositories: repos.map((repo) => ({
          ...repo,
          services: fleetServices.filter((service) => service.repoUrl === repo.cloneUrl).map((service) => service.name),
        })),
      }
    }
  )

  /**
   * Connect a repository.
   *
   * Two checks, and both matter: the installation must be one this org has
   * claimed, and the repository must be one that installation can actually
   * see. Checking only the second is what allowed a fleet to connect any
   * private repo belonging to any account that had ever installed the App.
   */
  app.post(
    '/fleets/:fleetId/github/repositories',
    { preHandler: requireFleetPermission('service.create') },
    async (req, reply) => {
      const githubConfig = github()
      const { fleetId } = req.params as { fleetId: string }
      const body = z
        .object({
          installationId: z.coerce.number().int().positive(),
          fullName: z.string().min(3).max(256),
          branch: z.string().min(1).max(255).optional(),
          manifestPath: z
            .string()
            .min(1)
            .max(255)
            .refine((value) => !value.startsWith('/') && !value.split('/').includes('..'), 'manifest path must stay inside the repository')
            .optional(),
        })
        .parse(req.body)

      await requireOrgInstallation(app.ctx, req.orgId!, body.installationId)

      const repos = await listRepos(githubConfig, body.installationId)
      const repo = repos.find((candidate) => candidate.full_name.toLowerCase() === body.fullName.toLowerCase())
      if (!repo) {
        throw ApiError.forbidden('That repository is not available to this GitHub App installation')
      }
      const account = repo.full_name.split('/')[0] ?? repo.full_name
      const [saved] = await app.ctx.db
        .insert(githubRepositories)
        .values({
          fleetId,
          installationId: String(body.installationId),
          account,
          fullName: repo.full_name,
          cloneUrl: repo.clone_url,
          defaultBranch: repo.default_branch,
          branch: body.branch ?? repo.default_branch,
          manifestPath: body.manifestPath ?? 'fleet.yaml',
          isPrivate: repo.private,
          createdByUserId: req.userId,
        })
        .onConflictDoUpdate({
          target: [githubRepositories.fleetId, githubRepositories.fullName],
          set: {
            installationId: String(body.installationId),
            cloneUrl: repo.clone_url,
            defaultBranch: repo.default_branch,
            branch: body.branch ?? repo.default_branch,
            manifestPath: body.manifestPath ?? 'fleet.yaml',
            isPrivate: repo.private,
          },
        })
        .returning()

      // Deploy it now. Waiting for a push means a freshly imported repository
      // sits there doing nothing until somebody makes a commit they did not
      // otherwise need — and the first thing anyone wants after importing is
      // to see whether it works.
      let deploying: { sha: string } | undefined
      let notDeployed: string | undefined
      try {
        const branch = saved!.branch
        const head = await branchHead(githubConfig, body.installationId, repo.full_name, branch)
        const hasManifest = await repoFileExists(
          githubConfig,
          body.installationId,
          repo.full_name,
          saved!.manifestPath,
          branch
        )
        if (!hasManifest) {
          // Not a failure. The connection is real and the next push with a
          // manifest will deploy; saying so beats an alert about a missing file.
          notDeployed = `no ${saved!.manifestPath} on ${branch} yet`
        } else {
          deploying = { sha: head }
          setImmediate(() => {
            void deployRepository(
              app,
              {
                fleetId,
                orgId: req.orgId!,
                gitSha: head,
                sourceUrl: repo.clone_url,
                candidates: repoCandidates({ full_name: repo.full_name, clone_url: repo.clone_url }),
                connected: saved,
                subject: repo.full_name,
              },
              req.log
            )
          })
        }
      } catch (err) {
        // The connection is saved either way; a first deploy that could not be
        // started is worth reporting, not worth rolling back.
        req.log.warn({ err, repository: repo.full_name }, 'could not start the first deploy on import')
        notDeployed = err instanceof GitHubError ? err.message : 'could not reach GitHub to start a deploy'
      }

      return reply.code(201).send({ repository: saved, deploying, notDeployed })
    }
  )

  app.delete(
    '/fleets/:fleetId/github/repositories/:repositoryId',
    { preHandler: requireFleetPermission('service.create') },
    async (req) => {
      const { fleetId, repositoryId } = req.params as { fleetId: string; repositoryId: string }
      const [removed] = await app.ctx.db
        .delete(githubRepositories)
        .where(and(eq(githubRepositories.id, repositoryId), eq(githubRepositories.fleetId, fleetId)))
        .returning()
      if (!removed) throw ApiError.notFound('GitHub repository connection')
      return { removed: { id: removed.id, fullName: removed.fullName } }
    }
  )
}

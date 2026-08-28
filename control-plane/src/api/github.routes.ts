import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import type { FastifyInstance } from 'fastify'
import { listInstallations, listRepos, GitHubError } from '../github/app.js'
import { githubRepositories, services } from '../db/schema.js'
import { ApiError } from './errors.js'
import { requireFleetPermission } from './guards.js'
import { publicApiOrigin } from './install.routes.js'

/**
 * Read-only GitHub surface for the dashboard: which accounts have installed
 * the app, and which repositories each installation can reach.
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
    try {
      const installations = await listInstallations(app.ctx.github)
      return {
        configured: true,
        webhookBase,
        clientId: app.ctx.github.clientId ?? null,
        installations: installations.map((i) => ({ id: i.id, account: i.account.login, type: i.account.type })),
      }
    } catch (err) {
      // A bad key is a configuration problem the operator needs told about,
      // not a 500 with a stack trace.
      if (err instanceof GitHubError) {
        return { configured: true, webhookBase, error: err.message, installations: [] }
      }
      throw err
    }
  })

  app.get('/fleets/:fleetId/github/catalog', { preHandler: requireFleetPermission('service.read') }, async (req) => {
    const config = github()
    const { installation } = req.query as { installation?: string }

    const installations = await listInstallations(config)
    if (!installations.length) {
      throw new ApiError(
        404,
        'no_installation',
        'The GitHub App is not installed on any account yet. Install it, choosing the repositories Fleet OS may read.'
      )
    }

    const target = installation
      ? installations.find((i) => String(i.id) === installation)
      : installations[0]
    if (!target) throw ApiError.notFound('Installation')

    const repos = await listRepos(config, target.id)
    return {
      installation: { id: target.id, account: target.account.login },
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
   * Connect only a repository the configured App can already see. Never trust
   * a clone URL posted by the browser: otherwise a user could make the server
   * fetch an arbitrary remote when a webhook arrives.
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
      return reply.code(201).send({ repository: saved })
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

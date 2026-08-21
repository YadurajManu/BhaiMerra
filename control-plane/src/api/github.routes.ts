import type { FastifyInstance } from 'fastify'
import { listInstallations, listRepos, GitHubError } from '../github/app.js'
import { ApiError } from './errors.js'
import { requireUser } from './guards.js'
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

  app.get('/github/status', { preHandler: requireUser }, async (req) => {
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

  app.get('/github/repos', { preHandler: requireUser }, async (req) => {
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
}

import { createHmac, timingSafeEqual } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { fleets, githubRepositories, services } from '../db/schema.js'
import {
  orgForInstallation,
  orgRepositories,
  releaseInstallation,
  setInstallationSuspended,
  pruneRepositories,
} from '../github/installations.js'
import { normaliseRepo, repoCandidates } from '../github/repo-url.js'
import { deployRepository } from './repo-deploy.js'
import { ApiError } from './errors.js'

// Re-exported: this module was the original home, and callers (and tests)
// still reach for it here.
export { normaliseRepo }

/**
 * Verify a GitHub-style HMAC over the *raw* body.
 *
 * Re-serialising the parsed JSON would change whitespace and key order and the
 * signature would never match, so the raw bytes are captured before parsing.
 */
export function verifyGithubSignature(raw: string, secret: string, header: string): boolean {
  const expected = 'sha256=' + createHmac('sha256', secret).update(raw).digest('hex')
  const a = Buffer.from(expected)
  const b = Buffer.from(header)
  return a.length === b.length && timingSafeEqual(a, b)
}

const pushEvent = z.object({
  ref: z.string(),
  after: z.string().optional(),
  head_commit: z.object({ id: z.string() }).nullable().optional(),
  repository: z.object({
    full_name: z.string().optional(),
    clone_url: z.string().optional(),
    ssh_url: z.string().optional(),
    html_url: z.string().optional(),
  }),
  /** Present on every event delivered to a GitHub App, absent on a plain
   *  repository webhook — which is exactly how the two paths tell apart. */
  installation: z.object({ id: z.number() }).optional(),
})

/**
 * Which connected repositories a push should deploy.
 *
 * Two filters, and both are load-bearing: the repository has to be one of
 * them (a push arrives for every repo the App can see, most of which are not
 * connected here), and the ref has to be the branch that connection watches
 * (otherwise every feature branch deploys to production).
 */
export function pushTargets<T extends { cloneUrl: string; branch: string }>(
  connections: T[],
  candidates: string[],
  ref: string
): T[] {
  return connections.filter(
    (repo) => candidates.includes(normaliseRepo(repo.cloneUrl)) && ref === `refs/heads/${repo.branch}`
  )
}

/** The sha a push event is about, or null when it deleted a branch. */
function pushedSha(push: z.infer<typeof pushEvent>): string | null {
  const sha = push.head_commit?.id ?? push.after
  // A branch deletion pushes an all-zero sha; there is nothing to build.
  if (!sha || /^0+$/.test(sha)) return null
  return sha
}

const installationEvent = z.object({
  action: z.string(),
  installation: z.object({
    id: z.number(),
    account: z.object({ login: z.string(), type: z.string().optional() }).optional(),
  }),
  repositories_removed: z.array(z.object({ full_name: z.string() })).optional(),
})

export async function webhookRoutes(app: FastifyInstance) {
  const { db } = app.ctx

  // Signature verification needs the exact bytes GitHub signed.
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'string' },
    (req, body, done) => {
      ;(req as { rawBody?: string }).rawBody = body as string
      try {
        done(null, JSON.parse(body as string))
      } catch (err) {
        done(err as Error, undefined)
      }
    }
  )

  /** Shared by both webhook endpoints; unset secret means verification is off. */
  const verified = (req: FastifyRequest): boolean => {
    const secret = app.ctx.config.WEBHOOK_SECRET
    if (!secret) return true
    const signature = req.headers['x-hub-signature-256']
    if (typeof signature !== 'string') return false
    return verifyGithubSignature((req as { rawBody?: string }).rawBody ?? '', secret, signature)
  }

  /**
   * A push delivered to the App itself.
   *
   * The installation id identifies the account, the claim identifies the org,
   * and the org's connected repositories say which fleets care. One repository
   * may be connected to several fleets; each gets its own deploy.
   */
  async function handleAppPush(req: FastifyRequest, reply: import('fastify').FastifyReply) {
    const parsed = pushEvent.safeParse(req.body)
    if (!parsed.success) {
      throw ApiError.unprocessable('unrecognised_payload', 'This does not look like a push event')
    }
    const push = parsed.data

    if (!push.installation) {
      // Delivered to the App's URL but without an installation — nothing here
      // can say whose it is, and guessing is how tenancy holes are made.
      return { ok: true, ignored: 'no installation on the event' }
    }

    const gitSha = pushedSha(push)
    if (!gitSha) return { ok: true, ignored: 'branch deleted' }

    const installationId = String(push.installation.id)
    const claim = await orgForInstallation(app.ctx, installationId)
    if (!claim) {
      // Installed on GitHub but never bound to an org. Reported in the
      // dashboard as an unclaimed installation; ignoring it is correct.
      return { ok: true, ignored: 'installation is not connected to an organisation' }
    }
    if (claim.suspendedAt) return { ok: true, ignored: 'installation suspended' }

    const candidates = repoCandidates(push.repository)
    // Scoped to the claiming org: two orgs may each have connected the same
    // public repository, and a push carrying one org's installation must not
    // deploy into the other's fleets.
    const connections = (await orgRepositories(app.ctx, claim.orgId)).filter((repo) =>
      candidates.includes(normaliseRepo(repo.cloneUrl))
    )
    if (!connections.length) {
      return { ok: true, ignored: 'repository is not connected to any fleet', repository: candidates[0] }
    }

    const onBranch = pushTargets(connections, candidates, push.ref)
    if (!onBranch.length) {
      return {
        ok: true,
        ignored: `watching ${[...new Set(connections.map((r) => r.branch))].join(', ')}, received ${push.ref}`,
      }
    }

    // Ack now; build after. See the note above the per-fleet handler.
    void reply.send({
      ok: true,
      ref: push.ref,
      sha: gitSha.slice(0, 12),
      fleets: onBranch.map((repo) => repo.fleetId),
    })

    setImmediate(() => {
      for (const repo of onBranch) {
        void deployRepository(
          app,
          {
            fleetId: repo.fleetId,
            orgId: claim.orgId,
            gitSha,
            sourceUrl: repo.cloneUrl,
            candidates,
            connected: repo,
            ref: push.ref,
            subject: repo.fullName,
          },
          req.log
        )
      }
    })

    return reply
  }

  /**
   * Installation lifecycle, app-wide.
   *
   * Unlike the push endpoint there is no fleet in the path: these events are
   * about the App itself, and the installation id is what identifies the
   * account. This is the half of the connection that keeps access *revocable* —
   * without it, uninstalling Fleet from a GitHub account leaves rows here that
   * still look connected in the dashboard.
   *
   * `created` is deliberately ignored. An installation only becomes an org's
   * when somebody completes the install flow from inside Fleet and the setup
   * callback redeems their nonce; a webhook alone cannot say whose it is.
   */
  app.post('/webhooks/github', async (req, reply) => {
    if (!verified(req)) throw ApiError.unauthorized('Invalid webhook signature')

    const event = req.headers['x-github-event']
    if (event === 'ping') return { ok: true, pong: true }

    // A push delivered to the App covers every repository the App is
    // installed on, so connecting a repository in the dashboard is the whole
    // setup — nobody adds a webhook to a repository by hand again.
    if (event === 'push') return handleAppPush(req, reply)

    if (event !== 'installation' && event !== 'installation_repositories') {
      return { ok: true, ignored: `event "${String(event ?? 'none')}"` }
    }

    const parsed = installationEvent.safeParse(req.body)
    if (!parsed.success) {
      throw ApiError.unprocessable('unrecognised_payload', 'This does not look like an installation event')
    }
    const { action, installation, repositories_removed: removed } = parsed.data
    const installationId = String(installation.id)

    if (event === 'installation') {
      switch (action) {
        case 'deleted': {
          const result = await releaseInstallation(app.ctx, installationId)
          req.log.info({ installationId, ...result }, 'GitHub installation removed')
          return { ok: true, released: result }
        }
        case 'suspend':
        case 'unsuspend': {
          const found = await setInstallationSuspended(app.ctx, installationId, action === 'suspend')
          return { ok: true, [action === 'suspend' ? 'suspended' : 'unsuspended']: found }
        }
        default:
          return { ok: true, ignored: `installation action "${action}"` }
      }
    }

    // Keyed on the payload rather than the action: GitHub may report removals
    // alongside additions, and a revocation must not be missed because the
    // event happened to be labelled "added".
    if (removed?.length) {
      const pruned = await pruneRepositories(
        app.ctx,
        installationId,
        removed.map((r) => r.full_name)
      )
      req.log.info({ installationId, pruned }, 'GitHub repositories removed from installation')
      return { ok: true, pruned }
    }

    return { ok: true, ignored: `installation_repositories action "${action}"` }
  })

  /**
   * The "push" half of git-push deploys (PRD 7.2).
   *
   * Responds before building. A webhook sender times out in seconds and a
   * multi-arch build takes minutes; holding the connection open would make
   * every deploy look like a failed delivery and get itself retried.
   */
  app.post('/webhooks/git/:fleetId', async (req, reply) => {
    const { fleetId } = req.params as { fleetId: string }

    const [fleet] = await db.select().from(fleets).where(eq(fleets.id, fleetId)).limit(1)
    if (!fleet) throw ApiError.notFound('Fleet')

    // Anyone who can reach this endpoint could otherwise trigger builds.
    if (!verified(req)) throw ApiError.unauthorized('Invalid webhook signature')

    const event = req.headers['x-github-event']
    if (event === 'ping') return { ok: true, pong: true }
    if (event && event !== 'push') return { ok: true, ignored: `event "${event}"` }

    const parsed = pushEvent.safeParse(req.body)
    if (!parsed.success) {
      throw ApiError.unprocessable('unrecognised_payload', 'This does not look like a push event')
    }
    const push = parsed.data

    const gitSha = pushedSha(push)
    if (!gitSha) return { ok: true, ignored: 'branch deleted' }

    const candidates = repoCandidates(push.repository)

    const fleetServices = await db
      .select()
      .from(services)
      .where(and(eq(services.fleetId, fleetId)))

    const connectedRepositories = await db
      .select()
      .from(githubRepositories)
      .where(eq(githubRepositories.fleetId, fleetId))
    const connected = connectedRepositories.find((repo) => candidates.includes(normaliseRepo(repo.cloneUrl)))

    if (connected && push.ref !== `refs/heads/${connected.branch}`) {
      return { ok: true, ignored: `watching ${connected.branch}, received ${push.ref}` }
    }

    const matched = fleetServices.filter(
      (s) => s.repoUrl && candidates.includes(normaliseRepo(s.repoUrl))
    )

    if (!matched.length && !connected) {
      // Not an error: a repo may legitimately have no services in this fleet.
      return {
        ok: true,
        ignored: 'no service in this fleet is bound to that repository',
        repository: candidates[0],
      }
    }

    // Ack now; build after. See the note above the handler.
    void reply.send({
      ok: true,
      ref: push.ref,
      sha: gitSha.slice(0, 12),
      triggered: matched.map((s) => s.name),
      manifest: connected?.manifestPath ?? 'fleet.yaml',
    })

    // All matched services share one repository and commit. Fetch once so the
    // exact fleet.yaml and all builds come from the same tree, not from
    // whatever happens to be on the default branch when the webhook arrives.
    const source = matched[0]
    const sourceUrl = connected?.cloneUrl ?? source?.repoUrl
    if (!sourceUrl) return reply

    setImmediate(() => {
      void deployRepository(
        app,
        {
          fleetId,
          orgId: fleet.orgId,
          gitSha,
          sourceUrl,
          candidates,
          connected,
          ref: push.ref,
          subject: source?.name ?? connected?.fullName ?? 'repository',
        },
        req.log
      )
    })

    return reply
  })
}

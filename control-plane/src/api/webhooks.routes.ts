import { createHmac, timingSafeEqual } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import type { FastifyInstance } from 'fastify'
import { fleets, services } from '../db/schema.js'
import { checkoutRepo } from '../git/checkout.js'
import { deployFromPush } from './deploy.js'
import { dispatchEvent } from '../alerting/dispatch.js'
import { ApiError } from './errors.js'

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
})

/** Repos are written many ways; compare them on the part that identifies them. */
export function normaliseRepo(url: string): string {
  return url
    .trim()
    .toLowerCase()
    .replace(/^git\+/, '')
    .replace(/^https?:\/\//, '')
    .replace(/^git@/, '')
    .replace(/:/g, '/')
    .replace(/\.git$/, '')
    .replace(/\/+$/, '')
}

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

    const secret = app.ctx.config.WEBHOOK_SECRET
    if (secret) {
      const signature = req.headers['x-hub-signature-256']
      const raw = (req as { rawBody?: string }).rawBody ?? ''
      if (typeof signature !== 'string' || !verifyGithubSignature(raw, secret, signature)) {
        // Anyone who can reach this endpoint could otherwise trigger builds.
        throw ApiError.unauthorized('Invalid webhook signature')
      }
    }

    const event = req.headers['x-github-event']
    if (event === 'ping') return { ok: true, pong: true }
    if (event && event !== 'push') return { ok: true, ignored: `event "${event}"` }

    const parsed = pushEvent.safeParse(req.body)
    if (!parsed.success) {
      throw ApiError.unprocessable('unrecognised_payload', 'This does not look like a push event')
    }
    const push = parsed.data

    const gitSha = push.head_commit?.id ?? push.after
    if (!gitSha || /^0+$/.test(gitSha)) {
      // A branch deletion pushes an all-zero sha; there is nothing to build.
      return { ok: true, ignored: 'branch deleted' }
    }

    const candidates = [
      push.repository.clone_url,
      push.repository.ssh_url,
      push.repository.html_url,
      push.repository.full_name,
    ]
      .filter(Boolean)
      .map((u) => normaliseRepo(u as string))

    const fleetServices = await db
      .select()
      .from(services)
      .where(and(eq(services.fleetId, fleetId)))

    const matched = fleetServices.filter(
      (s) => s.repoUrl && candidates.includes(normaliseRepo(s.repoUrl))
    )

    if (!matched.length) {
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
    })

    setImmediate(async () => {
      for (const service of matched) {
        try {
          // Fetch the tree at the pushed commit, then deploy it. Failures are
          // recorded and alerted on rather than thrown into a dead request.
          const checkout = await checkoutRepo({
            repoUrl: service.repoUrl!,
            gitSha,
            workdir: app.ctx.config.BUILD_WORKDIR,
          })
          await deployFromPush(app, service, gitSha, checkout.path)
          req.log.info({ service: service.name, sha: gitSha.slice(0, 12) }, 'push deploy succeeded')
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          req.log.error({ err, service: service.name }, 'push deploy failed')
          await dispatchEvent(
            app.ctx,
            {
              type: 'deploy.failed',
              fleetId,
              at: new Date().toISOString(),
              subject: service.name,
              detail: { sha: gitSha.slice(0, 12), ref: push.ref, reason: message },
            },
            { log: req.log }
          )
        }
      }
    })

    return reply
  })
}

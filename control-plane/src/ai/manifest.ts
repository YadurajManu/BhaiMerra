import { chat } from './provider.js'
import { parseManifest, ManifestError } from '../manifest/parse.js'
import type { AppContext } from '../api/context.js'

/**
 * A second opinion on a generated fleet.yaml.
 *
 * `fleet init` reads a repository with rules: workspace globs, dependency
 * lists, conventional directory names. Those are exact where they apply and
 * silent where they do not, and real repositories are mostly the second case —
 * a Vite app beside an Express server beside an admin panel, three package
 * managers, a Dockerfile that already knows the answer. The rules produced a
 * draft that named a source directory as a service and missed that two of the
 * three needed no health check at all.
 *
 * So the model does not write the manifest. It is handed the draft and the
 * evidence the rules read, and asked what is wrong with it. That ordering
 * matters: a model generating from scratch invents plausible ports and health
 * paths, and a plausible wrong port is exactly the failure that takes an hour
 * to find. Correcting a draft against evidence is a smaller, checkable job.
 *
 * Whatever comes back is parsed by the same parser the control plane applies
 * with. A manifest the system would reject never reaches the user, and the
 * draft is returned instead — so the worst case is the deterministic answer
 * everybody was getting anyway.
 */

export const DAILY_LIMIT = 5

export type AssistOutcome =
  | {
      status: 'ok'
      manifest: string
      notes: string[]
      changed: boolean
      model: string
      usage: { used: number; limit: number }
    }
  | { status: 'disabled'; reason: string }
  | { status: 'rate_limited'; limit: number; resetsInSec: number }
  | { status: 'kept_draft'; reason: string }

const limitKey = (userId: string) => `ai:manifest:${userId}:${new Date().toISOString().slice(0, 10)}`

function secondsUntilUtcMidnight(): number {
  const now = new Date()
  const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)
  return Math.max(1, Math.round((midnight - now.getTime()) / 1000))
}

/**
 * The rules the draft was built from, restated for the model.
 *
 * Every prohibition here is a bug this project actually shipped. The health
 * path one cost an hour: a guessed `/` against an API with a global prefix
 * fails every probe for ever, and the deploy sits at "deploying" while the
 * service serves traffic correctly. Left to its own instincts a model writes
 * exactly that guess, because it looks like every other manifest it has read.
 */
const SYSTEM = `You correct a generated fleet.yaml for Fleet OS. You are given a draft and evidence read from the repository.

Return JSON only:
{"manifest": "<the corrected fleet.yaml>", "notes": ["<one line per change, saying what evidence justified it>"]}

Rules, in order of importance:

1. Use only what the evidence shows. If the evidence does not say, leave the draft alone. Never infer a port, a path or a dependency from what projects of this kind usually do.

2. Never invent a health check. Only write "health: { path: X }" when the evidence shows a route serving X — a router line, an Express/Fastify/Nest route, a static index.html at the root. An API behind a global prefix does NOT serve "/". When in doubt omit the health block entirely: with none, container state decides and the service comes up, whereas a wrong path fails every probe for ever and the deploy never completes.

3. Always write container_port for every service, and take it from evidence: an EXPOSE line, a listen() call, a PORT default, a framework's documented default. Omitting it does not mean 80 — an unset port becomes 8080 on the node.

4. A directory that is part of a project is not a service. src, public, static, assets, test, tests, migrations, dist, build are never services. A repository's root can be a service; its own source directory cannot be a second one.

5. Databases only when a driver appears in a dependency list (pg, mongoose, redis, mysql2, prisma...). "uses:" names databases only, never other services.

6. Keep service names kebab-case, and keep any part of the draft you have no evidence to change.

Write nothing outside the JSON.`

/** Pull the object out of a reply that may be fenced or padded with prose. */
function parseReply(content: string): { manifest: string; notes: string[] } {
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/)
  const raw = (fenced?.[1] ?? content).trim()
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('the model did not return JSON')

  const parsed = JSON.parse(raw.slice(start, end + 1)) as { manifest?: unknown; notes?: unknown }
  const manifest = typeof parsed.manifest === 'string' ? parsed.manifest.trim() : ''
  if (!manifest) throw new Error('the model returned no manifest')

  const notes = Array.isArray(parsed.notes)
    ? parsed.notes.filter((n): n is string => typeof n === 'string' && n.trim().length > 0).slice(0, 12)
    : []

  return { manifest, notes }
}

/** Ignoring whitespace, so a reformat is not reported as a change. */
const same = (a: string, b: string) => a.replace(/\s+/g, ' ').trim() === b.replace(/\s+/g, ' ').trim()

export async function assistManifest(
  ctx: AppContext,
  opts: { userId: string; draft: string; repoMap: string },
  fetchImpl: typeof fetch = fetch
): Promise<AssistOutcome> {
  const { AI_API_KEY: apiKey, AI_BASE_URL: baseUrl, AI_MODEL: model } = ctx.config
  if (!apiKey) {
    return {
      status: 'disabled',
      reason: 'No AI provider is configured on this control plane.',
    }
  }

  // The draft has to survive whatever happens next, so it is validated first.
  // If the deterministic answer is already invalid there is a bug in `init`,
  // and quietly asking a model to paper over it would hide that.
  try {
    parseManifest(opts.draft)
  } catch (err) {
    return {
      status: 'kept_draft',
      reason:
        err instanceof ManifestError
          ? `The generated draft is not valid: ${err.issues.map((i) => `${i.path}: ${i.message}`).join('; ')}`
          : 'The generated draft is not valid.',
    }
  }

  const key = limitKey(opts.userId)
  const used = await ctx.redis.incr(key)
  if (used === 1) await ctx.redis.expire(key, secondsUntilUtcMidnight())
  if (used > DAILY_LIMIT) {
    return { status: 'rate_limited', limit: DAILY_LIMIT, resetsInSec: secondsUntilUtcMidnight() }
  }

  const refund = async () => {
    await ctx.redis.decr(key).catch(() => {})
  }

  let reply: { manifest: string; notes: string[] }
  try {
    const { content } = await chat(
      { apiKey, baseUrl, model },
      [
        { role: 'system', content: SYSTEM },
        {
          role: 'user',
          content: `Draft fleet.yaml:\n\n${opts.draft}\n\nEvidence from the repository:\n\n${opts.repoMap}`,
        },
      ],
      // Larger than the explainer's: the answer contains a whole manifest, and
      // a reasoning model spends part of this budget before writing any of it.
      { maxTokens: 3000 },
      fetchImpl
    )
    reply = parseReply(content)
  } catch (err) {
    await refund()
    return {
      status: 'kept_draft',
      reason: err instanceof Error ? err.message : 'The provider call failed.',
    }
  }

  // The guardrail. Whatever the model produced has to survive the parser the
  // control plane applies with, or the user never sees it.
  try {
    parseManifest(reply.manifest)
  } catch (err) {
    await refund()
    return {
      status: 'kept_draft',
      reason:
        err instanceof ManifestError
          ? `The suggested manifest was rejected: ${err.issues.map((i) => `${i.path}: ${i.message}`).join('; ')}`
          : 'The suggested manifest could not be parsed.',
    }
  }

  return {
    status: 'ok',
    manifest: reply.manifest,
    notes: reply.notes,
    changed: !same(reply.manifest, opts.draft),
    model,
    usage: { used, limit: DAILY_LIMIT },
  }
}

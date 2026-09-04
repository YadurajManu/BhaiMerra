import { chat } from './provider.js'
import { parseManifest, ManifestError } from '../manifest/parse.js'
import { applyEdits, parseEdits, type Edit } from './edits.js'
import { nodes } from '../db/schema.js'
import { eq } from 'drizzle-orm'
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

/** Default when AI_DAILY_LIMIT is not set. The operator pays; they choose. */
export const DAILY_LIMIT = 20

/**
 * Something the evidence cannot settle, offered as a choice.
 *
 * The rules say never guess. That leaves real gaps — which service the public
 * URL belongs to, whether a worker should be pinned — that a person answers in
 * seconds and a model can only invent. Asking is the honest form of not
 * knowing, and it is why these come back as options rather than as decisions
 * already made.
 */
export type Question = {
  id: string
  ask: string
  why: string
  options: Array<{ value: string; label: string }>
}

export type AssistOutcome =
  | {
      status: 'ok'
      manifest: string
      notes: string[]
      questions: Question[]
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
{"manifest": "<the corrected fleet.yaml>",
 "notes": ["<one line per change, saying what evidence justified it>"],
 "questions": [{"id": "<short-slug>", "ask": "<one question>", "why": "<why the evidence cannot settle it>", "options": [{"value": "<exact value to use>", "label": "<what it means>"}]}]}

Questions are for what the evidence genuinely cannot settle and a person answers in seconds: which service the public URL belongs to, whether a background worker should be pinned, which of two ports is the one that serves traffic. Ask at most three, each with two to four concrete options. Ask nothing you could have read from the evidence, and never ask for a value you should have refused to guess — put that in the manifest as an omission instead. If the evidence settles everything, return an empty list.

Rules, in order of importance:

1. Use only what the evidence shows. If the evidence does not say, leave the draft alone. Never infer a port, a path or a dependency from what projects of this kind usually do.

2. Never invent a health check. Only write "health: { path: X }" when the evidence shows a route serving X — a router line, an Express/Fastify/Nest route, a static index.html at the root. An API behind a global prefix does NOT serve "/". When in doubt omit the health block entirely: with none, container state decides and the service comes up, whereas a wrong path fails every probe for ever and the deploy never completes.

3. Always write container_port for every service, and take it from evidence: an EXPOSE line, a listen() call, a PORT default, a framework's documented default. Omitting it does not mean 80 — an unset port becomes 8080 on the node.

4. A directory that is part of a project is not a service. src, public, static, assets, test, tests, migrations, dist, build are never services. A repository's root can be a service; its own source directory cannot be a second one.

5. Databases only when a driver appears in a dependency list (pg, mongoose, redis, mysql2, prisma...). "uses:" names databases only, never other services.

5b. Never replace a service's "build:" with an "image:". Source lives in the repository, not in a public image. A compose file may well say "image: nginx:alpine" and mount ./frontend into it — that mount is a host directory, it cannot exist on a node, and the same image there serves its own welcome page instead of the site. A service whose content comes from the repo must be built.

5a. "node:" names a physical machine in the fleet. It is the one field no evidence in a repository can settle — a compose service called "mongo" is not a machine. You are told below which nodes exist; use one of those names or leave the draft's value exactly as it is. Never invent one.

6. Keep service names kebab-case, and keep any part of the draft you have no evidence to change.

Write nothing outside the JSON.`

/**
 * The per-service prompt.
 *
 * Narrower than the whole-manifest one in the way that matters: it is shown
 * one service and asked what is wrong with that service, so it cannot damage
 * a service it was never given — and it returns edits, so it cannot damage
 * the one it was given by rewriting it badly.
 */
const SERVICE_SYSTEM = `You review one service in a Fleet OS manifest against evidence from its directory.

Return JSON only:
{"edits": [{"service": "<name>", "field": "<field>", "value": <value or null>, "why": "<the evidence that justifies it>"}],
 "questions": [{"id": "<slug>", "ask": "<one question>", "why": "<why the evidence cannot settle it>", "options": [{"value": "<value>", "label": "<meaning>"}]}]}

You may edit only: container_port, health, resources, placement, replicas, env, command. A null value removes the field.

Rules:

1. Use only what the evidence shows. If it does not say, change nothing. Never infer a port or a path from what projects of this kind usually do.

2. Never invent a health check. Only set "health" when the evidence shows a route serving that path — an Express/Fastify/Nest route, a static index.html at the root. An API behind a global prefix does NOT serve "/". Where the draft has a health check the evidence does not support, remove it with a null value: no check means container state decides and the service comes up, whereas a wrong path fails every probe for ever.

3. container_port comes from evidence: an EXPOSE line, a listen() call, a PORT default. Never from habit.

4. You cannot change node, build, image, uses, volume or name. Those name machines, source and data, and no repository can settle them. Do not ask about them either.

5. Return an empty edits list when the draft is already right. That is the common answer and a good one.

Write nothing outside the JSON.`

/** Pull the object out of a reply that may be fenced or padded with prose. */
function parseReply(content: string): { manifest: string; notes: string[]; questions: Question[] } {
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/)
  const raw = (fenced?.[1] ?? content).trim()
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('the model did not return JSON')

  const parsed = JSON.parse(raw.slice(start, end + 1)) as {
    manifest?: unknown
    notes?: unknown
    questions?: unknown
  }
  const manifest = typeof parsed.manifest === 'string' ? parsed.manifest.trim() : ''
  if (!manifest) throw new Error('the model returned no manifest')

  const notes = Array.isArray(parsed.notes)
    ? parsed.notes.filter((n): n is string => typeof n === 'string' && n.trim().length > 0).slice(0, 12)
    : []

  // A malformed question is dropped rather than failing the whole review: the
  // manifest is the answer, and questions are an extra.
  const questions: Question[] = Array.isArray(parsed.questions)
    ? (parsed.questions as unknown[])
        .filter((q): q is Question => {
          const c = q as Partial<Question>
          return (
            typeof c?.id === 'string' &&
            typeof c?.ask === 'string' &&
            Array.isArray(c?.options) &&
            c!.options!.length > 1 &&
            c!.options!.every((o) => typeof o?.value === 'string' && typeof o?.label === 'string')
          )
        })
        .slice(0, 3)
    : []

  return { manifest, notes, questions }
}

/**
 * Whether a provider refused because the request was too big.
 *
 * Every provider says it differently and none of them say it in a field, so
 * this reads the message. Worth doing: the response is to send less, which is
 * something we can actually do, unlike almost every other provider error.
 */
function tooLarge(message: string): boolean {
  return /too large|context length|maximum context|tokens per minute|reduce your message|413/i.test(
    message
  )
}

/**
 * The evidence, cut down for a second attempt.
 *
 * Keeps the head of each section rather than dropping whole sections: a
 * service described by the first fifteen lines of its package.json is still
 * described, whereas a service dropped entirely is invisible and the review
 * will confidently say nothing about it.
 */
function trimMap(map: string): string {
  return map
    .split(/\n(?=## )/)
    .map((section) => {
      const lines = section.split('\n')
      if (lines.length <= 12) return section
      return [...lines.slice(0, 12), '…'].join('\n')
    })
    .join('\n')
}

/** Ignoring whitespace, so a reformat is not reported as a change. */
const same = (a: string, b: string) => a.replace(/\s+/g, ' ').trim() === b.replace(/\s+/g, ' ').trim()

export async function assistManifest(
  ctx: AppContext,
  opts: {
    userId: string
    /** Whose nodes the manifest may name. */
    fleetId: string
    draft: string
    repoMap: string
    /** Answers to a previous round's questions, as id -> chosen value. */
    answers?: Record<string, string>
    /**
     * Evidence per service, when the caller can split it.
     *
     * Present: one pass per service, each seeing only its own directory, so
     * depth does not have to be traded against fitting a token budget. Absent:
     * the whole map in one pass, which is what an older CLI sends.
     */
    parts?: Array<{ service: string; map: string }>
  },
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
  let draftParsed: ReturnType<typeof parseManifest>
  try {
    draftParsed = parseManifest(opts.draft)
  } catch (err) {
    return {
      status: 'kept_draft',
      reason:
        err instanceof ManifestError
          ? `The generated draft is not valid: ${err.issues.map((i) => `${i.path}: ${i.message}`).join('; ')}`
          : 'The generated draft is not valid.',
    }
  }

  // The node names this fleet actually has, so the model can choose correctly
  // rather than guessing — and so a guess can be caught below.
  const fleetNodes = await ctx.db
    .select({ name: nodes.name })
    .from(nodes)
    .where(eq(nodes.fleetId, opts.fleetId))
  const nodeNames = fleetNodes.map((n) => n.name)

  const key = limitKey(opts.userId)
  const used = await ctx.redis.incr(key)
  if (used === 1) await ctx.redis.expire(key, secondsUntilUtcMidnight())
  const limit = ctx.config.AI_DAILY_LIMIT ?? DAILY_LIMIT
  if (used > limit) {
    return { status: 'rate_limited', limit, resetsInSec: secondsUntilUtcMidnight() }
  }

  const refund = async () => {
    await ctx.redis.decr(key).catch(() => {})
  }

  // One pass per service when the caller split the evidence.
  //
  // The whole-repository pass has to fit everything into one request, and on a
  // seven-service project that meant trimming the map 44% — after which a
  // review that had made six corrections made none. Per service, each request
  // carries one directory at full depth, so a large repository gets a better
  // review rather than a thinner one.
  //
  // It costs one allowance, not one per service: the user asked for a review,
  // and how many requests that takes is an implementation detail they did not
  // choose.
  if (opts.parts?.length) {
    const edits: Edit[] = []
    const notes: string[] = []
    const questions: Question[] = []
    let asked = 0
    let failures = 0

    for (const part of opts.parts) {
      try {
        const { content } = await chat(
          { apiKey, baseUrl, model },
          [
            { role: 'system', content: SERVICE_SYSTEM },
            {
              role: 'user',
              content: [
                `The manifest:\n\n${opts.draft}`,
                `Review the service "${part.service}". Evidence from its directory:\n\n${part.map}`,
                opts.answers && Object.keys(opts.answers).length
                  ? `Already answered; treat as settled:\n${Object.entries(opts.answers)
                      .map(([id, value]) => `  ${id}: ${value}`)
                      .join('\n')}`
                  : '',
              ]
                .filter(Boolean)
                .join('\n\n'),
            },
          ],
          { maxTokens: 1200 },
          fetchImpl
        )
        const out = parseEdits(content)
        asked++
        // A pass may only edit the service it was shown. Anything else is a
        // pass reaching outside its evidence, which is the whole reason for
        // splitting them up.
        edits.push(...out.edits.filter((e) => e.service === part.service))
        questions.push(...(out.questions as Question[]))
      } catch {
        // One service failing is not the review failing. The rest still have
        // something to say, and reporting nothing because the fourth of seven
        // timed out would waste the six that worked.
        failures++
      }
    }

    if (!asked) {
      await refund()
      return { status: 'kept_draft', reason: 'No service could be reviewed.' }
    }

    const result = applyEdits(opts.draft, edits)
    for (const e of result.applied) notes.push(`${e.service}: ${e.why}`)
    for (const r of result.refused) {
      notes.push(`${r.edit.service}: declined to change ${r.edit.field} — ${r.reason}`)
    }
    if (failures) notes.push(`${failures} service(s) could not be reviewed and were left as generated.`)

    // The merged result still has to survive the parser, and the guards that
    // apply to the manifest as a whole rather than to one service.
    try {
      parseManifest(result.manifest)
    } catch (err) {
      await refund()
      return {
        status: 'kept_draft',
        reason:
          err instanceof ManifestError
            ? `The edits produced an invalid manifest: ${err.issues.map((i) => `${i.path}: ${i.message}`).join('; ')}`
            : 'The edits produced a manifest that could not be parsed.',
      }
    }

    return {
      status: 'ok',
      manifest: result.manifest,
      notes,
      questions: questions.slice(0, 3),
      changed: result.applied.length > 0,
      model,
      usage: { used, limit },
    }
  }

  let reply: { manifest: string; notes: string[]; questions: Question[] }
  const ask = async (map: string) =>
    chat(
      { apiKey, baseUrl, model },
      [
        { role: 'system', content: SYSTEM },
        {
          role: 'user',
          content: [
            `Draft fleet.yaml:\n\n${opts.draft}`,
            `Evidence from the repository:\n\n${map}`,
            // Answered questions are settled facts, not suggestions. Asking
            // the same thing twice would make the prompt feel broken.
            nodeNames.length
              ? `Nodes in this fleet, the only valid values for "node:": ${nodeNames.join(', ')}`
              : 'This fleet has no nodes yet; leave any "node:" value exactly as the draft has it.',
            opts.answers && Object.keys(opts.answers).length
              ? `The user has answered these; treat them as evidence and ask nothing further about them:\n${Object.entries(
                  opts.answers
                )
                  .map(([id, value]) => `  ${id}: ${value}`)
                  .join('\n')}`
              : '',
          ]
            .filter(Boolean)
            .join('\n\n'),
        },
      ],
      // Larger than the explainer's: the answer contains a whole manifest, and
      // a reasoning model spends part of this budget before writing any of it.
      { maxTokens: 3000 },
      fetchImpl
    )

  try {
    let content: string
    try {
      content = (await ask(opts.repoMap)).content
    } catch (err) {
      // One retry, with less. A repository large enough to overflow a model's
      // limit is exactly the kind the review is most useful on, and refusing
      // it outright leaves the biggest projects with the least help. Only for
      // being too large: retrying a bad key or a WAF page would just spend the
      // same time to fail identically.
      const message = err instanceof Error ? err.message : ''
      if (!tooLarge(message)) throw err
      content = (await ask(trimMap(opts.repoMap))).content
    }
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
    const suggested = parseManifest(reply.manifest)

    // And it must not have invented a machine.
    //
    // Told to correct a draft against a repository, a model changed
    // `node: CHANGE_ME` to `node: mongo` because the compose file had a
    // service by that name. It reads as diligent and is the one inference no
    // repository can support: a container name is not a host. The manifest
    // parsed, `--dry-run` passed, and `fleet up` failed on a fleet with no
    // node called mongo.
    // And it must not have thrown the source away.
    //
    // A compose file saying `image: nginx:alpine` with `./frontend` mounted
    // into it is faithfully read as "this service is that image" — and it is,
    // on one machine. On a node there is no ./frontend to mount, so the
    // service came up serving nginx's welcome page while every status said
    // running. The manifest was valid, the deploy succeeded, and the site was
    // gone.
    const draftBuilds = new Set(
      draftParsed.services.filter((svc) => svc.build).map((svc) => svc.name)
    )
    const lostSource = suggested.services
      .filter((svc) => draftBuilds.has(svc.name) && !svc.build)
      .map((svc) => svc.name)
    if (lostSource.length) {
      await refund()
      return {
        status: 'kept_draft',
        reason:
          `The review replaced the build of ${lostSource.join(', ')} with a prebuilt image. ` +
          `Source in this repository has to be built — a public image on a node cannot contain it.`,
      }
    }

    const known = new Set(nodeNames)
    const invented = suggested.services.filter((svc) => svc.node && !known.has(svc.node))
    if (invented.length) {
      await refund()
      return {
        status: 'kept_draft',
        reason:
          `The review named ${invented.map((s) => `"${s.node}"`).join(', ')}, which ` +
          (nodeNames.length
            ? `is not a node in this fleet. This fleet has: ${nodeNames.join(', ')}.`
            : 'is not a node in this fleet.'),
      }
    }
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
    questions: reply.questions,
    changed: !same(reply.manifest, opts.draft),
    model,
    usage: { used, limit },
  }
}

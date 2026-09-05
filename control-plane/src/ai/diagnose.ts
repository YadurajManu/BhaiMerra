import { chat } from './provider.js'
import { callTool, TOOLS, type ToolResult } from './tools.js'
import { applicability } from './edits.js'
import type { AppContext } from '../api/context.js'

/**
 * Work out why a service is not doing what it should, by asking.
 *
 * Every failure this project hit in a day cost twenty to sixty minutes, and
 * almost all of that was evidence-gathering rather than judgement: query the
 * deployments, read the node's heartbeat, compare what the control plane
 * believes against what the node reports, probe the public address. Six
 * questions in the right order, and the answer was usually in the replies.
 *
 * That is what this does. It is not the failure explainer, which reads a log
 * somebody already has; it goes and finds the log, and the deployment history
 * beside it, and the node that has been silent for nine minutes.
 *
 * Three things keep it honest. The tools are read-only, so the worst outcome
 * is a wrong opinion rather than a wrong action. Every finding must cite the
 * call that supports it, so a reader can check rather than trust. And it is
 * bounded — a diagnosis that will not converge stops and says what it saw,
 * because an agent looping on a fleet's data is a bill, not an investigation.
 */

/**
 * How many lookups one investigation may make.
 *
 * Raised from eight when a real question ran out mid-investigation: there are
 * nine lookups now, and an answer that also has to name a manifest change needs
 * room to check the change is right rather than plausible. Still bounded --
 * an agent looping on a fleet's data is a bill, not an investigation.
 */
export const MAX_CALLS = 12

/**
 * How long an investigation may take, whatever it has left to ask.
 *
 * Cloudflare gives an origin about a hundred seconds before it answers 524, and
 * a diagnosis that exceeds it returns nothing at all -- no summary, no
 * findings, not even the list of what it looked at. The step budget alone does
 * not bound this: twelve lookups against a slow model is comfortably past it,
 * and raising the step count is what pushed a working command over the edge.
 *
 * Eighty-five seconds leaves room for the final answer to be composed and sent
 * inside the window. A partial answer that arrives beats a complete one that
 * does not.
 */
export const DEADLINE_MS = 85_000

export type Finding = {
  /** What is claimed. */
  claim: string
  /** The tool call that supports it, so the claim can be checked. */
  evidence: string
}

/** One manifest change, and whether a machine is allowed to make it. */
export type ProposedFix = {
  service: string
  field: string
  value: string | number | boolean | null
  why: string
  /** False for a change only a person should make; `reason` says why. */
  applicable: boolean
  reason?: string
}

export type Diagnosis =
  | {
      status: 'ok'
      summary: string
      findings: Finding[]
      next: string[]
      fix?: ProposedFix
      calls: Array<{ tool: string; args: Record<string, unknown> }>
      model: string
    }
  | { status: 'disabled'; reason: string }
  | { status: 'inconclusive'; reason: string; calls: Array<{ tool: string; args: Record<string, unknown> }> }

const SYSTEM = `You work out why a service on Fleet OS is misbehaving, by asking for information one question at a time.

Do not use function calling. This conversation has no functions available: emitting one is an error and the investigation stops. Reply with a JSON object and nothing else, one of:

  {"lookup": {"name": "<which>", "args": {...}}}
  {"answer": {"summary": "<one or two sentences>", "findings": [{"claim": "<what is true>", "evidence": "<the lookup and what it showed>"}], "next": ["<what the operator should do>"], "fix": {"service": "<name>", "field": "<manifest field>", "value": <new value, or null to remove it>, "why": "<what this changes>"}}}

What you can ask for:
  services {}                     — every service in the fleet and whether it is running
  deployments {service}           — its recent deployments: status, timing, failure reason, node, host port
  nodes {}                        — every node: status, architecture, agent version, seconds since its last heartbeat
  containers {node}               — what that node's last heartbeat says it is actually running, with health
  logs {service}                  — the container's own output, as last reported
  placements {service}            — why the scheduler moved it, and when
  history {service}               — what people and the system did to it: deployed, stopped, restarted, rolled back, with who and how long ago
  probe {service}                 — fetch its public address: status, size, first bytes
  context {service}               — the files the builder was given for its last build, oddities first

How to work:

Establish what is true before guessing what is wrong. For a named service, ask for its deployments first — a failure reason usually names the cause outright.

Separate what is true now from what was true. Deployments and history come back newest first, and older entries describe a fleet that has since changed: a run of failures during an outage an hour ago does not explain a service that is down this minute. Before concluding that something is broken, check whether somebody simply stopped it — on a small fleet that is the most common reason of all, and it leaves no failure, no container and no error anywhere except the history.

Look for disagreement. The control plane's view and the node's are both available, and most real failures live in the gap: a deployment marked running whose container the node never mentions, a container the node calls unhealthy while it serves traffic, a service reported running that answers 502.

A build that failed is about what went in. Ask for the context before theorising about the Dockerfile: the archive is assembled on someone's machine and is not the directory they think it is. A service whose Dockerfile globs -- COPY *.csproj . , COPY *.json . -- copies whatever matches, and Docker's globs count a leading dot where a shell does not, so a stray ._name file becomes a second match nobody can see from the source tree.

A 200 is not proof. Check the size and first bytes — a static site replaced by its web server's welcome page returns 200 and about 900 bytes.

Every finding cites what showed it. A claim you cannot point at is a guess, and a guess in a diagnosis is worse than no diagnosis.

Include a fix only when the evidence names one exact manifest change that would resolve what you found, and leave it out entirely otherwise. It is a field on a service in fleet.yaml -- container_port, health, resources, env, command, replicas, placement -- and a wrong one is applied to somebody's running system, so a guess here is worse than nothing. Say what you found and stop.

Answer as soon as you can support an answer. If the evidence does not settle it, say what you established and what you would look at next: an honest partial answer is useful and a confident wrong one is not.

Write nothing outside the JSON.`

/**
 * The first complete JSON object in a reply, by matching braces.
 *
 * Taking everything between the first `{` and the last `}` looks equivalent
 * and is not: a reply that is one object followed by a sentence, or by a
 * second object, slices into something that parses as neither. That ended a
 * real investigation one step in — "Unexpected non-whitespace character after
 * JSON at position 70" — with the usable object sitting in the first seventy
 * characters.
 *
 * Braces inside strings do not count, and neither does an escaped quote, or
 * a path in a log line closes the object early.
 */
function firstObject(raw: string): string | null {
  const start = raw.indexOf('{')
  if (start < 0) return null

  let depth = 0
  let inString = false
  let escaped = false

  for (let i = start; i < raw.length; i++) {
    const ch = raw[i]!
    if (escaped) {
      escaped = false
      continue
    }
    if (ch === '\\' && inString) {
      escaped = true
      continue
    }
    if (ch === '"') {
      inString = !inString
      continue
    }
    if (inString) continue
    if (ch === '{') depth++
    else if (ch === '}' && --depth === 0) return raw.slice(start, i + 1)
  }

  return null
}

/** Pull one step out of a reply that may be fenced or padded with prose. */
function parseStep(content: string): {
  call?: { tool: string; args: Record<string, unknown> }
  answer?: { summary: string; findings: Finding[]; next: string[]; fix?: ProposedFix }
} {
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/)
  const raw = (fenced?.[1] ?? content).trim()
  const object = firstObject(raw)
  if (!object) throw new Error('the model did not return JSON')

  const parsed = JSON.parse(object) as {
    lookup?: { name?: unknown; args?: unknown }
    call?: { tool?: unknown; args?: unknown }
    answer?: { summary?: unknown; findings?: unknown; next?: unknown; fix?: unknown }
  }

  // Either spelling. The prompt asks for "lookup"/"name", and a model that has
  // read a great many tool-calling examples reaches for "call"/"tool" anyway —
  // refusing that would fail an investigation over a synonym.
  const asked = parsed.lookup?.name ?? parsed.call?.tool
  if (typeof asked === 'string') {
    return {
      call: {
        tool: asked,
        args: ((parsed.lookup?.args ?? parsed.call?.args) ?? {}) as Record<string, unknown>,
      },
    }
  }

  if (parsed.answer && typeof parsed.answer.summary === 'string') {
    const findings = Array.isArray(parsed.answer.findings)
      ? (parsed.answer.findings as unknown[])
          .filter((f): f is Finding => {
            const c = f as Partial<Finding>
            return typeof c?.claim === 'string' && typeof c?.evidence === 'string'
          })
          .slice(0, 8)
      : []
    const next = Array.isArray(parsed.answer.next)
      ? (parsed.answer.next as unknown[]).filter((n): n is string => typeof n === 'string').slice(0, 5)
      : []
    return { answer: { summary: parsed.answer.summary, findings, next, fix: parseFix(parsed.answer.fix) } }
  }

  throw new Error('the model returned neither a lookup nor an answer')
}

/**
 * A proposed fix, checked before anybody is offered it.
 *
 * Validated here rather than where it is applied, so a change no machine should
 * make never reaches the CLI as something to confirm. A person clicking through
 * a prompt is not a guardrail; not offering the button is.
 *
 * A malformed fix is dropped rather than failing the answer: the findings above
 * it are still worth reading, and losing a whole investigation because one
 * optional field came back wrong is the wrong trade.
 */
function parseFix(raw: unknown): ProposedFix | undefined {
  const f = raw as Partial<ProposedFix> | undefined
  if (!f || typeof f.service !== 'string' || typeof f.field !== 'string' || typeof f.why !== 'string') {
    return undefined
  }
  const value = f.value
  if (
    value !== null &&
    typeof value !== 'string' &&
    typeof value !== 'number' &&
    typeof value !== 'boolean'
  ) {
    return undefined
  }

  const verdict = applicability({ service: f.service, field: f.field, value, why: f.why })
  return { service: f.service, field: f.field, value, why: f.why, ...verdict }
}

/**
 * Tool output, trimmed for a prompt.
 *
 * The whole conversation is resent on every turn, so an untrimmed log tail is
 * paid for once per remaining step. Eight steps of a forty-line log is the
 * difference between a diagnosis and a rate limit.
 */
function forPrompt(result: ToolResult): string {
  const text = JSON.stringify(result.ok ? result.data : { error: result.error })
  return text.length > 2_000 ? `${text.slice(0, 2_000)}… (truncated)` : text
}

/**
 * How many lookup results are kept in full.
 *
 * The whole conversation is resent on every turn, so each result is paid for
 * once per remaining step: raising the step budget to twelve is what took a
 * working investigation past a free tier's 8000 tokens a minute. Older results
 * are replaced by a line naming what was looked at, which keeps the thing that
 * matters — that it already asked, and need not ask again — at a fraction of
 * the cost.
 *
 * Three, because a diagnosis reasons about the last thing it saw against the
 * one or two before it. Findings are cited from the answer, not re-derived
 * from the transcript, so an older result having been compacted costs nothing
 * a reader sees.
 */
const KEEP_IN_FULL = 3

/**
 * Replace all but the most recent results with a one-line note.
 *
 * In place on the array, because the alternative is rebuilding the whole
 * conversation each turn and getting the assistant/user alternation subtly
 * wrong.
 */
function compact(messages: Array<{ role: string; content: string }>, resultAt: number[]): void {
  for (const i of resultAt.slice(0, -KEEP_IN_FULL)) {
    const first = messages[i]!.content.split('\n')[0] ?? ''
    if (first.endsWith('(already seen)')) continue
    messages[i]!.content = `${first.replace(/:$/, '')} (already seen)`
  }
}

export async function diagnose(
  ctx: AppContext,
  opts: { fleetId: string; question: string },
  fetchImpl: typeof fetch = fetch
): Promise<Diagnosis> {
  const { AI_API_KEY: apiKey, AI_BASE_URL: baseUrl, AI_MODEL: model } = ctx.config
  if (!apiKey) {
    return { status: 'disabled', reason: 'No AI provider is configured on this control plane.' }
  }

  const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: opts.question },
  ]
  const calls: Array<{ tool: string; args: Record<string, unknown> }> = []
  /** Whether the last reply was already a re-ask, so one slip costs a turn and not the investigation. */
  let retried = false

  const startedAt = Date.now()
  /** Where each lookup result sits, so the older ones can be shrunk. */
  const resultAt: number[] = []

  for (let step = 0; step < MAX_CALLS; step++) {
    // Out of time rather than out of steps. Reported the same way, because to
    // a reader they are the same thing: it stopped, and here is what it saw.
    if (Date.now() - startedAt > DEADLINE_MS) {
      return {
        status: 'inconclusive',
        reason: `Stopped after ${Math.round((Date.now() - startedAt) / 1000)}s without reaching an answer.`,
        calls,
      }
    }

    let content: string
    try {
      // Small budget per turn: a step is one tool call or one answer, and a
      // model given room to write an essay in the middle of an investigation
      // spends the conversation's tokens on prose nobody reads.
      const reply = await chat({ apiKey, baseUrl, model }, messages, { maxTokens: 900 }, fetchImpl)
      content = reply.content
    } catch (err) {
      return {
        status: 'inconclusive',
        reason: err instanceof Error ? err.message : 'the provider call failed',
        calls,
      }
    }

    let step_: ReturnType<typeof parseStep>
    try {
      step_ = parseStep(content)
    } catch (err) {
      // An unreadable reply is a formatting slip, not a dead end, and
      // discarding four good tool calls over one is the wrong trade. Say what
      // was wrong and let it answer again — once. A second failure in a row is
      // a model that cannot hold the protocol, and retrying that forever is
      // just a bill.
      if (retried) {
        return {
          status: 'inconclusive',
          reason: err instanceof Error ? err.message : 'the reply could not be read',
          calls,
        }
      }
      retried = true
      step--
      messages.push({ role: 'assistant', content })
      messages.push({
        role: 'user',
        content:
          `That reply could not be read: ${err instanceof Error ? err.message : 'invalid JSON'}. ` +
          `Reply with one JSON object and nothing else — no prose before or after it.`,
      })
      continue
    }
    retried = false

    if (step_.answer) {
      return {
        status: 'ok',
        summary: step_.answer.summary,
        findings: step_.answer.findings,
        next: step_.answer.next,
        fix: step_.answer.fix,
        calls,
        model,
      }
    }

    const call = step_.call!
    calls.push(call)
    const result = await callTool(ctx, opts.fleetId, call.tool, call.args)

    messages.push({ role: 'assistant', content })

    // Tell it what it has left.
    //
    // The loop used to run to exhaustion without warning, and a model that does
    // not know its budget cannot spend it: the run that prompted this made
    // eight lookups, each individually reasonable, and never stopped to answer.
    // Knowing the last step is the last one is what turns a wandering
    // investigation into a partial answer, and a partial answer with evidence
    // is worth a great deal more than "stopped after 12 calls".
    // Lookups available to the turn that reads this message, not to the one
    // that just finished. Counting the wrong one put the final warning after
    // the final request, where nothing ever read it.
    const left = Math.min(
      MAX_CALLS - step - 1,
      // Whichever runs out first. A model told it has nine lookups left while
      // eighty of its eighty-five seconds are gone will use them, and the
      // answer it was composing never gets sent.
      Math.max(0, Math.round((DEADLINE_MS - (Date.now() - startedAt)) / 8_000))
    )
    const budget =
      left <= 1
        ? '\n\nThis is your last lookup. Use it on something that would settle the question, or answer now with what you have and say plainly what you could not establish.'
        : left <= 3
          ? `\n\n${left} lookups left. Ask for something that would settle it, or answer with what you have.`
          : ''

    messages.push({
      role: 'user',
      content: `Result of ${call.tool}(${JSON.stringify(call.args)}):\n${forPrompt(result)}${budget}`,
    })
    resultAt.push(messages.length - 1)
    compact(messages, resultAt)
  }

  // Out of steps. Everything gathered is still worth reporting: a list of what
  // was looked at beats "I could not tell you", and the operator can see where
  // it got to.
  return {
    status: 'inconclusive',
    reason: `Stopped after ${MAX_CALLS} calls without reaching an answer. Available tools: ${Object.keys(
      TOOLS
    ).join(', ')}.`,
    calls,
  }
}

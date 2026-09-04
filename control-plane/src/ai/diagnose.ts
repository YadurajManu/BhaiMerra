import { chat } from './provider.js'
import { callTool, TOOLS, type ToolResult } from './tools.js'
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

export const MAX_CALLS = 8

export type Finding = {
  /** What is claimed. */
  claim: string
  /** The tool call that supports it, so the claim can be checked. */
  evidence: string
}

export type Diagnosis =
  | {
      status: 'ok'
      summary: string
      findings: Finding[]
      next: string[]
      calls: Array<{ tool: string; args: Record<string, unknown> }>
      model: string
    }
  | { status: 'disabled'; reason: string }
  | { status: 'inconclusive'; reason: string; calls: Array<{ tool: string; args: Record<string, unknown> }> }

const SYSTEM = `You diagnose why a service on Fleet OS is not behaving, by calling read-only tools.

Reply with JSON only, one of:
  {"call": {"tool": "<name>", "args": {...}}}
  {"answer": {"summary": "<one or two sentences>", "findings": [{"claim": "<what is true>", "evidence": "<the tool call and what it showed>"}], "next": ["<what the operator should do>"]}}

Tools:
  services {}                     — every service in the fleet and whether it is running
  deployments {service}           — its recent deployments: status, timing, failure reason, node, host port
  nodes {}                        — every node: status, architecture, agent version, seconds since its last heartbeat
  containers {node}               — what that node's last heartbeat says it is actually running, with health
  logs {service}                  — the container's own output, as last reported
  placements {service}            — why the scheduler moved it, and when
  probe {service}                 — fetch its public address: status, size, first bytes

How to work:

Start by establishing what is true, not by guessing what is wrong. "deployments" first for a named service — a failure reason usually names the cause outright.

Look for disagreement. The control plane's view and the node's are both available, and most real failures live in the gap: a deployment marked running whose container the node never mentions, a container the node calls unhealthy while it serves traffic, a service reported running that answers 502.

A 200 is not proof. Check the size and first bytes — a static site replaced by its web server's welcome page returns 200 and about 900 bytes.

Every finding cites the call that showed it. A claim you cannot point at is a guess, and a guess in a diagnosis is worse than no diagnosis.

Answer when you can support an answer. If the evidence does not settle it, say what you established and what you would look at next — an honest partial answer is useful and a confident wrong one is not.

Write nothing outside the JSON.`

/** Pull one step out of a reply that may be fenced or padded with prose. */
function parseStep(content: string): {
  call?: { tool: string; args: Record<string, unknown> }
  answer?: { summary: string; findings: Finding[]; next: string[] }
} {
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/)
  const raw = (fenced?.[1] ?? content).trim()
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('the model did not return JSON')

  const parsed = JSON.parse(raw.slice(start, end + 1)) as {
    call?: { tool?: unknown; args?: unknown }
    answer?: { summary?: unknown; findings?: unknown; next?: unknown }
  }

  if (parsed.call && typeof parsed.call.tool === 'string') {
    return {
      call: {
        tool: parsed.call.tool,
        args: (parsed.call.args ?? {}) as Record<string, unknown>,
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
    return { answer: { summary: parsed.answer.summary, findings, next } }
  }

  throw new Error('the model returned neither a call nor an answer')
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

  for (let step = 0; step < MAX_CALLS; step++) {
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
      return {
        status: 'inconclusive',
        reason: err instanceof Error ? err.message : 'the reply could not be read',
        calls,
      }
    }

    if (step_.answer) {
      return {
        status: 'ok',
        summary: step_.answer.summary,
        findings: step_.answer.findings,
        next: step_.answer.next,
        calls,
        model,
      }
    }

    const call = step_.call!
    calls.push(call)
    const result = await callTool(ctx, opts.fleetId, call.tool, call.args)

    messages.push({ role: 'assistant', content })
    messages.push({
      role: 'user',
      content: `Result of ${call.tool}(${JSON.stringify(call.args)}):\n${forPrompt(result)}`,
    })
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

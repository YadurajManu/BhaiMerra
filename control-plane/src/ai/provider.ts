/**
 * One client, every provider worth supporting.
 *
 * OpenAI's chat-completions shape is what agentrouter, OpenAI, Groq, Together
 * and a local Ollama all speak, so supporting "a base URL and a key" covers all
 * of them and costs nothing extra. Writing against a vendor SDK would have
 * bought a nicer type or two and locked the feature to one supplier, on a
 * product whose entire pitch is that you own the hardware.
 *
 * Nothing here retries. A failed explanation is not worth a second charge, and
 * the caller has something useful to show either way: the raw log was always
 * going to be displayed underneath.
 */

export type Explanation = {
  summary: string
  steps: string[]
  tokensIn: number
  tokensOut: number
  model: string
}

export type ProviderConfig = {
  baseUrl: string
  apiKey: string
  model: string
}

/** Long enough for a slow provider, short enough that nobody waits on it. */
const TIMEOUT_MS = 45_000

/**
 * Deliberately narrow. The model is being asked to read a build log, not to
 * hold a conversation, and the instruction says so in the terms the answer
 * will be judged by: what broke, and what to type next.
 */
const SYSTEM = `You explain why a container build or deploy failed, to a developer who is not fluent in Docker.

Answer as JSON only, no prose around it:
{"summary": "...", "steps": ["...", "..."]}

summary: two or three sentences naming what actually failed and why. Quote the exact error text that matters. No preamble, no "it looks like".
steps: the shortest sequence of concrete actions that fixes it. Shell commands where a command is the answer. Two to four steps. Empty array if the log does not say enough to be sure.

If the log is truncated or the cause is genuinely unclear, say so in summary and return no steps. Guessing costs the reader more time than admitting the log is not enough.`

type ChatResponse = {
  choices?: Array<{ message?: { content?: string } }>
  usage?: { prompt_tokens?: number; completion_tokens?: number }
  error?: { message?: string }
}

/** Pull the JSON object out of a reply that may be fenced or padded. */
function parseReply(content: string): { summary: string; steps: string[] } {
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/)
  const raw = (fenced?.[1] ?? content).trim()
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('the model did not return JSON')

  const parsed = JSON.parse(raw.slice(start, end + 1)) as { summary?: unknown; steps?: unknown }
  const summary = typeof parsed.summary === 'string' ? parsed.summary.trim() : ''
  if (!summary) throw new Error('the model returned no summary')

  const steps = Array.isArray(parsed.steps)
    ? parsed.steps.filter((s): s is string => typeof s === 'string' && s.trim().length > 0).slice(0, 6)
    : []

  return { summary, steps }
}

export async function explainWith(
  config: ProviderConfig,
  context: { log: string; manifest?: string | null; service?: string },
  fetchImpl: typeof fetch = fetch
): Promise<Explanation> {
  const parts = [`Service: ${context.service ?? 'unknown'}`, '', 'Failure log (tail):', context.log]
  if (context.manifest) parts.push('', 'Its fleet.yaml entry:', context.manifest)

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)

  try {
    const res = await fetchImpl(`${config.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        // Low, because this is reading a log rather than writing prose: the
        // same failure should not produce a different answer each time.
        temperature: 0.1,
        max_tokens: 700,
        messages: [
          { role: 'system', content: SYSTEM },
          { role: 'user', content: parts.join('\n') },
        ],
      }),
      signal: controller.signal,
    })

    const body = (await res.json().catch(() => ({}))) as ChatResponse
    if (!res.ok) {
      // The provider's own message, because "500" tells the operator nothing
      // about whether the key, the model name or the balance is the problem.
      throw new Error(`provider returned ${res.status}: ${body.error?.message ?? 'no detail'}`)
    }

    const content = body.choices?.[0]?.message?.content
    if (!content) throw new Error('provider returned no content')

    const { summary, steps } = parseReply(content)
    return {
      summary,
      steps,
      tokensIn: body.usage?.prompt_tokens ?? 0,
      tokensOut: body.usage?.completion_tokens ?? 0,
      model: config.model,
    }
  } finally {
    clearTimeout(timer)
  }
}

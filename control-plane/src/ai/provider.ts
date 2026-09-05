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
  choices?: Array<{ message?: { content?: string }; finish_reason?: string }>
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

/**
 * How long a provider asked us to wait, in milliseconds, or null.
 *
 * The header where there is one, the prose where there is not: Groq answers
 * 429 with "Please try again in 8.25s" and no Retry-After at all, and a wait
 * the provider stated is better than a number we invented.
 */
function waitHint(res: Response, message: string): number | null {
  const header = res.headers.get('retry-after')
  if (header) {
    const seconds = Number(header)
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000)
  }
  const prose = message.match(/try again in ([\d.]+)\s*s/i)
  if (prose) {
    const seconds = Number(prose[1])
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000)
  }
  return null
}

/**
 * One chat completion, with the failure modes this codebase has actually hit.
 *
 * Extracted so every caller gets them. Both were found the hard way and both
 * reported as "provider returned no content" until they were told apart: a
 * gateway answering HTTP 200 with an HTML bot-detection page, and a reasoning
 * model spending its whole completion budget thinking. A second caller writing
 * its own fetch would rediscover both.
 */
export async function chat(
  config: ProviderConfig,
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
  opts: {
    maxTokens?: number
    temperature?: number
    noRetry?: boolean
    retriesLeft?: number
    /**
     * A JSON schema the reply must satisfy, when the provider can enforce one.
     *
     * Constrained decoding rather than instruction. Every model this has run
     * against reaches for its own tool-calling syntax when a prompt describes
     * lookups: Groq refused a request outright with "Tool choice is none, but
     * model called a tool", and a local Gemma answered
     * `<|tool_call>call:services{}<tool_call|>` in place of the JSON asked for.
     * Both produce exactly the right object when handed a schema. A prompt
     * asks; this decides.
     */
    schema?: { name: string; schema: Record<string, unknown> }
    /** Set internally once a provider has shown it cannot enforce one. */
    noSchema?: boolean
  } = {},
  fetchImpl: typeof fetch = fetch
): Promise<{ content: string; tokensIn: number; tokensOut: number }> {
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
        temperature: opts.temperature ?? 0.1,
        max_tokens: opts.maxTokens ?? 1500,
        messages,
        ...(opts.schema && !opts.noSchema
          ? {
              response_format: {
                type: 'json_schema',
                json_schema: { name: opts.schema.name, schema: opts.schema.schema },
              },
            }
          : {}),
      }),
      signal: controller.signal,
    })

    // Read as text first, so a reply that is not JSON can be described rather
    // than silently becoming {}.
    const raw = await res.text()
    let body: ChatResponse = {}
    let parsed = true
    try {
      body = JSON.parse(raw) as ChatResponse
    } catch {
      parsed = false
    }

    if (!parsed) {
      const type = res.headers.get('content-type') ?? 'no content-type'
      const looksLikeChallenge = /<!doctype html|<html|waf|captcha/i.test(raw.slice(0, 500))
      const snippet = raw.slice(0, 140).replace(/\s+/g, ' ').trim()
      throw new Error(
        `provider replied with ${type} instead of JSON (HTTP ${res.status})` +
          (looksLikeChallenge
            ? ' — this looks like a bot-detection or WAF challenge page, which usually means the' +
              ' provider is refusing requests from this server rather than from you. The same key' +
              ' often works from a laptop and not from a datacenter address.'
            : '') +
          ` First bytes: ${snippet}`
      )
    }

    if (!res.ok) {
      // A rate limit that says when to come back is worth waiting out.
      //
      // Per-minute budgets are the common case on a free tier, and the wait is
      // usually seconds — the provider prints it, in the header or in prose.
      // Failing instead throws away whatever the caller had just done: an
      // interactive answer, a review somebody waited for.
      //
      // More than once, because a per-minute budget is a rolling window and one
      // wait of the hinted length is often not enough to clear it. An
      // investigation makes a dozen requests against 8000 tokens a minute and
      // hit this repeatedly: the provider said "try again in 585ms", the single
      // retry did, the window had not moved, and the whole investigation was
      // thrown away over a wait measured in seconds. Bounded by a count and by
      // the hint being short, so a provider that is genuinely down still fails
      // fast rather than being asked forever.
      const retryAfter = waitHint(res, body.error?.message ?? '')
      const retriesLeft = opts.retriesLeft ?? 3
      if (
        res.status === 429 &&
        retryAfter !== null &&
        retryAfter <= 30_000 &&
        !opts.noRetry &&
        retriesLeft > 0
      ) {
        // A little longer each time. The hint says when this request could have
        // been served, not when the next one can, and retrying on exactly the
        // hint lands in the same full window again.
        const backoff = retryAfter + 250 * (4 - retriesLeft) ** 2
        await new Promise((resolve) => setTimeout(resolve, backoff))
        return chat(config, messages, { ...opts, retriesLeft: retriesLeft - 1 }, fetchImpl)
      }

      // A provider that cannot constrain its output is asked again without a
      // schema, rather than failing.
      //
      // `response_format: json_schema` is the difference between a reply this
      // can parse and one it cannot, so it is worth asking for -- but it is not
      // universal, and refusing to work against an endpoint that lacks it would
      // trade a real capability for a nicety. The prompt still asks for JSON,
      // and the parser still copes with a model that answers in its own
      // dialect; the schema just removes the need to.
      const message = body.error?.message ?? ''
      if (
        res.status === 400 &&
        opts.schema &&
        !opts.noSchema &&
        /response_format|json_schema|schema/i.test(message)
      ) {
        return chat(config, messages, { ...opts, noSchema: true }, fetchImpl)
      }

      // The provider's own message, because "500" tells the operator nothing
      // about whether the key, the model name or the balance is the problem.
      throw new Error(`provider returned ${res.status}: ${body.error?.message ?? 'no detail'}`)
    }

    const choice = body.choices?.[0]
    const content = choice?.message?.content

    if (!content && choice?.finish_reason === 'length') {
      throw new Error(
        'the model ran out of tokens before writing an answer' +
          ' — it is likely a reasoning model spending the completion budget on' +
          ' thinking. Raise max_tokens or choose a model that does not reason.'
      )
    }

    if (!content) throw new Error('provider returned no content')

    return {
      content,
      tokensIn: body.usage?.prompt_tokens ?? 0,
      tokensOut: body.usage?.completion_tokens ?? 0,
    }
  } finally {
    clearTimeout(timer)
  }
}

export async function explainWith(
  config: ProviderConfig,
  context: { log: string; manifest?: string | null; service?: string },
  fetchImpl: typeof fetch = fetch
): Promise<Explanation> {
  const parts = [`Service: ${context.service ?? 'unknown'}`, '', 'Failure log (tail):', context.log]
  if (context.manifest) parts.push('', 'Its fleet.yaml entry:', context.manifest)

  const { content, tokensIn, tokensOut } = await chat(
    config,
    [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: parts.join('\n') },
    ],
    { maxTokens: 1500 },
    fetchImpl
  )

  const { summary, steps } = parseReply(content)
  return { summary, steps, tokensIn, tokensOut, model: config.model }
}

import { createHmac, timingSafeEqual } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import { alertRules } from '../db/schema.js'
import { toDiscord, toSlack, toWebhook, toEmail, severityOf } from './format.js'
import type { AppContext } from '../api/context.js'
import type { FleetEventPayload } from '../lib/events.js'

export type DeliveryResult = {
  ruleId: string
  channel: string
  ok: boolean
  status?: number
  error?: string
  attempts: number
}

const MAX_ATTEMPTS = 3
const TIMEOUT_MS = 8000

/**
 * Sign the raw body so a receiver can verify the alert actually came from us.
 * An unauthenticated webhook that says "your database is down" is a way to
 * make someone panic on demand.
 */
export function signPayload(body: string, secret: string): string {
  return 'sha256=' + createHmac('sha256', secret).update(body).digest('hex')
}

export function verifySignature(body: string, secret: string, signature: string): boolean {
  const expected = Buffer.from(signPayload(body, secret))
  const given = Buffer.from(signature)
  return expected.length === given.length && timingSafeEqual(expected, given)
}

type Channel = 'webhook' | 'discord' | 'slack' | 'email' | 'push'

/** Pluggable so email can be wired to a real provider without touching this. */
export interface EmailSender {
  send(to: string, subject: string, body: string): Promise<void>
}

/**
 * Fan an event out to every rule subscribed to it (FR-12).
 *
 * Delivery never throws: an unreachable Discord webhook must not stop the
 * sweeper from detecting the next dead node, and it must not stop the *other*
 * channels for the same event either.
 */
export async function dispatchEvent(
  ctx: AppContext,
  event: FleetEventPayload,
  opts: {
    email?: EmailSender
    fetchImpl?: typeof fetch
    log?: { info: (o: unknown, m: string) => void; warn: (o: unknown, m: string) => void }
  } = {}
): Promise<DeliveryResult[]> {
  const rules = await ctx.db
    .select()
    .from(alertRules)
    .where(and(eq(alertRules.fleetId, event.fleetId), eq(alertRules.enabled, true)))

  const matching = rules.filter(
    // An empty subscription list means "everything" — the sane default for
    // someone who just wants to be told when something happens.
    (r) => r.eventTypes.length === 0 || r.eventTypes.includes(event.type)
  )
  if (!matching.length) return []

  const results = await Promise.all(
    matching.map((rule) =>
      deliver(rule.id, rule.channelType as Channel, rule.channelConfig, event, opts).catch(
        (err): DeliveryResult => ({
          ruleId: rule.id,
          channel: rule.channelType,
          ok: false,
          error: String(err),
          attempts: 0,
        })
      )
    )
  )

  for (const r of results) {
    if (r.ok) opts.log?.info({ event: event.type, channel: r.channel }, 'alert delivered')
    else opts.log?.warn({ event: event.type, channel: r.channel, error: r.error }, 'alert delivery failed')
  }
  return results
}

async function deliver(
  ruleId: string,
  channel: Channel,
  config: Record<string, unknown>,
  event: FleetEventPayload,
  opts: { email?: EmailSender; fetchImpl?: typeof fetch }
): Promise<DeliveryResult> {
  if (channel === 'email') {
    const to = String(config.to ?? '')
    if (!opts.email) {
      return { ruleId, channel, ok: false, error: 'no email sender configured', attempts: 0 }
    }
    const { subject, body } = toEmail(event)
    await opts.email.send(to, subject, body)
    return { ruleId, channel, ok: true, attempts: 1 }
  }

  const url = String(config.url ?? '')
  if (!url) return { ruleId, channel, ok: false, error: 'rule has no url', attempts: 0 }

  const payload =
    channel === 'discord' ? toDiscord(event) : channel === 'slack' ? toSlack(event) : toWebhook(event)
  const body = JSON.stringify(payload)

  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (channel === 'webhook') {
    headers['x-fleet-event'] = event.type
    headers['x-fleet-severity'] = severityOf(event.type)
    const secret = config.secret ? String(config.secret) : ''
    if (secret) headers['x-fleet-signature'] = signPayload(body, secret)
  }

  const doFetch = opts.fetchImpl ?? fetch
  let lastError = ''
  let lastStatus: number | undefined

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await doFetch(url, {
        method: 'POST',
        headers,
        body,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
      lastStatus = res.status

      if (res.ok) return { ruleId, channel, ok: true, status: res.status, attempts: attempt }

      // 4xx other than 429 will not succeed on a retry — a bad URL stays bad.
      if (res.status < 500 && res.status !== 429) {
        return {
          ruleId,
          channel,
          ok: false,
          status: res.status,
          error: `endpoint rejected the alert (${res.status})`,
          attempts: attempt,
        }
      }
      lastError = `HTTP ${res.status}`
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err)
    }

    if (attempt < MAX_ATTEMPTS) {
      await new Promise((r) => setTimeout(r, 250 * 2 ** (attempt - 1)))
    }
  }

  return { ruleId, channel, ok: false, status: lastStatus, error: lastError, attempts: MAX_ATTEMPTS }
}

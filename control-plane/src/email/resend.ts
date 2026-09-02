import type { EmailSender } from '../alerting/dispatch.js'

/**
 * Email delivery through Resend.
 *
 * The alerting layer was written with this seam already cut: `deliver()` takes
 * an `EmailSender` and every rule with `channelType: 'email'` has been matched,
 * formatted and then dropped on the floor because nothing ever supplied one.
 * This is the missing half.
 *
 * Retries live here rather than in `deliver()`. A webhook delivery gets three
 * attempts; the email branch returns after a single `send()`, so without this a
 * transient 429 from Resend would silently lose the one email telling somebody
 * their node is down.
 */

const ENDPOINT = 'https://api.resend.com/emails'
const MAX_ATTEMPTS = 3
const TIMEOUT_MS = 10_000

/** Retry only what retrying can fix. A 422 for a malformed address never will. */
function worthRetrying(status: number): boolean {
  return status === 408 || status === 429 || status >= 500
}

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}
const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ESCAPES[c]!)

/**
 * Alert bodies arrive as plain text from `toEmail()`. Send that as the text
 * part and derive a readable HTML part from it, so the message is multipart:
 * a text-only email is markedly more likely to be filed as spam, and a
 * text-only *alert* is the one that most needs to arrive.
 *
 * A body that already starts with a tag is passed through untouched, which is
 * how the auth emails will supply their own markup later.
 */
function render(body: string): { text: string; html: string } {
  if (body.trimStart().startsWith('<')) {
    return { text: body.replace(/<[^>]+>/g, ''), html: body }
  }

  const lines = body.split('\n')
  const [headline, ...rest] = lines
  const html =
    `<div style="font:14px/1.6 ui-sans-serif,-apple-system,'Segoe UI',sans-serif;color:#12161b;max-width:560px">` +
    `<div style="font-size:16px;font-weight:600;margin-bottom:14px">${escapeHtml(headline ?? '')}</div>` +
    rest
      .map((l) =>
        l.trim() === ''
          ? '<div style="height:10px"></div>'
          : `<div style="color:#59616d;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12.5px">${escapeHtml(l)}</div>`
      )
      .join('') +
    `<div style="margin-top:18px;padding-top:12px;border-top:1px solid #dfe3e8;color:#838c98;font-size:11.5px">` +
    `Sent by Fleet OS because an alert rule matched this event.</div></div>`

  return { text: body, html }
}

export class ResendEmailSender implements EmailSender {
  constructor(
    private readonly apiKey: string,
    private readonly from: string,
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  async send(to: string, subject: string, body: string): Promise<void> {
    if (!to) throw new Error('email rule has no "to" address')
    const { text, html } = render(body)

    let lastError = 'no attempt made'

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      let res: Response
      try {
        res = await this.fetchImpl(ENDPOINT, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${this.apiKey}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ from: this.from, to, subject, text, html }),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        })
      } catch (err) {
        // Network failure or timeout: worth another go.
        lastError = err instanceof Error ? err.message : String(err)
        if (attempt < MAX_ATTEMPTS) {
          await new Promise((r) => setTimeout(r, 400 * attempt))
          continue
        }
        throw new Error(`resend: ${lastError}`)
      }

      if (res.ok) return

      // Resend puts the reason in the body, not the status line, and the
      // status line alone ("422") is useless when debugging a bounce.
      const detail = (await res.text().catch(() => '')).slice(0, 300)
      lastError = `${res.status} ${detail}`

      if (!worthRetrying(res.status) || attempt === MAX_ATTEMPTS) {
        throw new Error(`resend: ${lastError}`)
      }
      await new Promise((r) => setTimeout(r, 400 * attempt))
    }

    throw new Error(`resend: ${lastError}`)
  }
}

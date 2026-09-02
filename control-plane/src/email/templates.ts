/**
 * Transactional email bodies.
 *
 * These are the first thing a stranger sees from Fleet OS, and two of them
 * arrive at the worst moment someone has with the product — locked out, or
 * worried their account was taken. They are written to be read in four
 * seconds and to be obviously not a phishing attempt.
 *
 * Deliberately hand-built HTML with inline styles: mail clients strip <style>
 * blocks, ignore most of CSS, and Gmail in particular discards anything it
 * does not recognise. This is the subset that survives everywhere.
 */

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ESCAPES[c]!)

const SANS = "ui-sans-serif,-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif"
const MONO = "ui-monospace,SFMono-Regular,Menlo,Consolas,monospace"

type Block = {
  heading: string
  lines: string[]
  /** Optional fact block, rendered between the two runs of paragraphs. */
  table?: string
  /** Paragraphs after the table. */
  lines2?: string[]
  action?: { label: string; url: string }
  footer: string
}

function shell({ heading, lines, table, lines2, action, footer }: Block): string {
  return (
    `<div style="font:14px/1.65 ${SANS};color:#12161b;max-width:520px;padding:8px">` +
    `<div style="font:600 12px/1 ${MONO};letter-spacing:.16em;text-transform:uppercase;color:#0b8f4d;margin-bottom:20px">fleet&middot;os</div>` +
    `<div style="font-size:19px;font-weight:600;letter-spacing:-.02em;margin-bottom:14px">${esc(heading)}</div>` +
    lines.map((l) => `<p style="margin:0 0 12px;color:#3d4551">${esc(l)}</p>`).join('') +
    (table ?? '') +
    (lines2 ?? []).map((l) => `<p style="margin:0 0 12px;color:#3d4551">${esc(l)}</p>`).join('') +
    (action
      ? `<p style="margin:22px 0"><a href="${esc(action.url)}" style="display:inline-block;background:#0b8f4d;color:#fff;` +
        `text-decoration:none;padding:11px 20px;font-weight:600;font-size:14px">${esc(action.label)}</a></p>` +
        `<p style="margin:0 0 12px;color:#838c98;font-size:12px">If the button does not work, paste this into your browser:<br>` +
        `<span style="font-family:${MONO};font-size:11.5px;word-break:break-all;color:#59616d">${esc(action.url)}</span></p>`
      : '') +
    `<div style="margin-top:24px;padding-top:14px;border-top:1px solid #e3e6ea;color:#838c98;font-size:11.5px">${esc(footer)}</div>` +
    `</div>`
  )
}

export function passwordResetEmail(url: string, ttlMinutes: number) {
  return {
    subject: 'Reset your Fleet OS password',
    body: shell({
      heading: 'Reset your password',
      lines: [
        `This link works once and expires in ${ttlMinutes} minutes.`,
        'If you did not ask for this, you can ignore it. Your password has not changed, and whoever requested it cannot see this email.',
      ],
      action: { label: 'Choose a new password', url },
      footer: 'Sent by Fleet OS because a password reset was requested for this address.',
    }),
  }
}

export function verifyEmail(url: string) {
  return {
    subject: 'Confirm your email for Fleet OS',
    body: shell({
      heading: 'Confirm your email',
      lines: [
        'This confirms the address on your Fleet OS account so you can recover it later.',
        'The link is good for 24 hours.',
      ],
      action: { label: 'Confirm this address', url },
      footer: 'Sent by Fleet OS because this address was used to create an account.',
    }),
  }
}

/**
 * No link, on purpose.
 *
 * A security notice containing a login button trains people to click login
 * links in email, which is the exact behaviour every credential-phishing
 * campaign depends on. Tell them what happened and let them navigate to the
 * dashboard the way they normally would.
 */
export function passwordChangedEmail(at: Date, dashboardUrl?: string) {
  return {
    subject: 'Your Fleet OS password was changed',
    body: shell({
      heading: 'Your password was changed',
      lines: [
        `This happened at ${at.toISOString().replace('T', ' ').slice(0, 19)} UTC.`,
        'If that was you, nothing more is needed.',
        dashboardUrl
          ? `If it was not, someone else has access to your account. Go to ${dashboardUrl} yourself — do not use a link from an email — and change your password immediately.`
          : 'If it was not, someone else has access to your account. Sign in and change your password immediately.',
      ],
      footer: 'Sent by Fleet OS because your password changed. We never ask you to confirm credentials by email.',
    }),
  }
}

/** Facts as a two-column block. Mail clients handle a table far better than a grid. */
function factTable(rows: Array<[string, string]>): string {
  return (
    `<table cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:18px 0;width:100%">` +
    rows
      .map(
        ([k, v]) =>
          `<tr>` +
          `<td style="padding:7px 16px 7px 0;border-bottom:1px solid #eef0f3;color:#838c98;` +
          `font:11px/1.4 ${MONO};letter-spacing:.1em;text-transform:uppercase;white-space:nowrap;vertical-align:top">${esc(k)}</td>` +
          `<td style="padding:7px 0;border-bottom:1px solid #eef0f3;color:#12161b;font:13.5px/1.5 ${MONO}">${esc(v)}</td>` +
          `</tr>`
      )
      .join('') +
    `</table>`
  )
}

const COUNTRY: Record<string, string> = {
  IN: 'India', US: 'United States', GB: 'United Kingdom', DE: 'Germany', FR: 'France',
  NL: 'Netherlands', SG: 'Singapore', JP: 'Japan', AU: 'Australia', CA: 'Canada',
  BR: 'Brazil', IE: 'Ireland', SE: 'Sweden', ES: 'Spain', IT: 'Italy',
  AE: 'the UAE', T1: 'the Tor network',
}
export const countryName = (code: string | null) =>
  !code ? 'Unknown location' : (COUNTRY[code] ?? code)

/**
 * A new sign-in was recorded on the account.
 *
 * Contains no link and no button, which is the whole point. A security notice
 * with a "secure your account" button is indistinguishable from the phishing
 * email that copies it, and clicking one is the behaviour that gets people
 * compromised. It states facts and tells the reader to navigate themselves.
 */
export function newSignInEmail(opts: {
  device: string
  ip: string | null
  country: string | null
  at: Date
  reason: 'first_device' | 'new_country' | 'known'
  dashboardUrl?: string
}) {
  const where = countryName(opts.country)
  const headline =
    opts.reason === 'new_country'
      ? `New sign-in from ${where}`
      : `New sign-in from ${opts.device}`

  const rows: Array<[string, string]> = [
    ['device', opts.device],
    ['location', opts.country ? where : 'Could not be determined'],
    ['ip address', opts.ip ?? 'Not recorded'],
    ['when', `${opts.at.toISOString().replace('T', ' ').slice(0, 19)} UTC`],
  ]

  return {
    subject: `[fleet-os] ${headline}`,
    body: shell({
      heading: headline,
      lines: [
        opts.reason === 'new_country'
          ? 'Your account was used from a country it has not been used from before.'
          : 'Your account was signed in to from a device we have not seen before.',
      ],
      table: factTable(rows),
      lines2: [
        'If this was you, nothing more is needed and you can ignore this.',
        opts.dashboardUrl
          ? `If it was not you, change your password now. Open ${opts.dashboardUrl} by typing it yourself — never through a link in an email, including this one.`
          : 'If it was not you, sign in and change your password immediately.',
      ],
      footer:
        'Sent by Fleet OS because a sign-in did not match a device or location on file. ' +
        'We will never ask you to confirm a password by email.',
    }),
  }
}

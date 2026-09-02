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

type Block = { heading: string; lines: string[]; action?: { label: string; url: string }; footer: string }

function shell({ heading, lines, action, footer }: Block): string {
  return (
    `<div style="font:14px/1.65 ${SANS};color:#12161b;max-width:520px;padding:8px">` +
    `<div style="font:600 12px/1 ${MONO};letter-spacing:.16em;text-transform:uppercase;color:#0b8f4d;margin-bottom:20px">fleet&middot;os</div>` +
    `<div style="font-size:19px;font-weight:600;letter-spacing:-.02em;margin-bottom:14px">${esc(heading)}</div>` +
    lines.map((l) => `<p style="margin:0 0 12px;color:#3d4551">${esc(l)}</p>`).join('') +
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

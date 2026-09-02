import type { FleetEvent, FleetEventPayload } from '../lib/events.js'

export type Severity = 'info' | 'warning' | 'critical'

/**
 * Severity per event type. Deliberately explicit rather than inferred from the
 * name: a reschedule is routine and a pinned service being down is not, and
 * that difference is the whole point of the alerting story (PRD 6.4).
 */
const SEVERITY: Record<FleetEvent, Severity> = {
  'node.registered': 'info',
  'node.online': 'info',
  'node.down': 'warning',
  'node.cordoned': 'info',
  'node.drained': 'info',
  'node.removed': 'warning',
  'deploy.started': 'info',
  'deploy.succeeded': 'info',
  'deploy.failed': 'warning',
  'deploy.rolled_back': 'warning',
  'service.rescheduled': 'info',
  'service.pinned_unavailable': 'critical',
  'service.crash_looping': 'critical',
  'volume.flexible_warning': 'warning',
  'drift.detected': 'warning',
}

export const severityOf = (type: FleetEvent): Severity => SEVERITY[type] ?? 'info'

const COLOUR: Record<Severity, number> = {
  info: 0x3fe08b,
  warning: 0xffb547,
  critical: 0xff5f52,
}

/**
 * One sentence a human can act on, without opening the dashboard. This is the
 * text most users will actually read, so it says what happened, to what, and
 * what the system did about it.
 */
export function headline(event: FleetEventPayload): string {
  const d = event.detail ?? {}
  switch (event.type) {
    case 'node.down':
      return `Node ${event.subject} stopped responding after ${d.missedThreshold ?? '?'} missed heartbeats.`
    case 'node.online':
      return `Node ${event.subject} is back online.`
    case 'service.rescheduled':
      return d.failed
        ? `${event.subject} could not be rescheduled: ${d.summary ?? 'no eligible node'}`
        : `${event.subject} moved to ${d.to} automatically.`
    case 'service.pinned_unavailable':
      return `${event.subject} is DOWN and was not moved — it is pinned to a node that went offline.`
    case 'service.crash_looping':
      return `${event.subject} is crash-looping.`
    case 'deploy.failed':
      return `Deploy of ${event.subject} failed.`
    case 'deploy.succeeded':
      return `${event.subject} deployed successfully.`
    case 'drift.detected':
      return `Unmanaged workload detected on ${event.subject}.`
    default:
      return `${event.type}: ${event.subject}`
  }
}

/** Extra context worth showing, as label/value pairs. */
export function fields(event: FleetEventPayload): Array<[string, string]> {
  const d = event.detail ?? {}
  const out: Array<[string, string]> = []
  const add = (k: string, v: unknown) => {
    if (v !== undefined && v !== null && v !== '') out.push([k, String(v)])
  }

  switch (event.type) {
    case 'node.down':
      add('Silent for', d.silentForMs ? `${Math.round(Number(d.silentForMs) / 1000)}s` : undefined)
      add('Heartbeat interval', d.intervalSec ? `${d.intervalSec}s` : undefined)
      break
    case 'service.rescheduled':
      add('From', d.from)
      add('To', d.to)
      add('Placement score', typeof d.score === 'number' ? d.score.toFixed(3) : undefined)
      break
    case 'service.pinned_unavailable':
      add('Why', d.why)
      add('Node', d.nodeId)
      break
  }
  return out
}

export function toDiscord(event: FleetEventPayload) {
  const severity = severityOf(event.type)
  return {
    embeds: [
      {
        title: headline(event),
        color: COLOUR[severity],
        timestamp: event.at,
        footer: { text: `fleet-os · ${event.type}` },
        fields: fields(event).map(([name, value]) => ({ name, value, inline: true })),
      },
    ],
  }
}

export function toSlack(event: FleetEventPayload) {
  const severity = severityOf(event.type)
  const icon = severity === 'critical' ? ':rotating_light:' : severity === 'warning' ? ':warning:' : ':white_check_mark:'
  const extra = fields(event)
  return {
    text: `${icon} ${headline(event)}`,
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: `${icon} *${headline(event)}*` } },
      ...(extra.length
        ? [{ type: 'section', fields: extra.map(([k, v]) => ({ type: 'mrkdwn', text: `*${k}*\n${v}` })) }]
        : []),
      {
        type: 'context',
        elements: [{ type: 'mrkdwn', text: `fleet-os · \`${event.type}\` · ${event.at}` }],
      },
    ],
  }
}

/** The generic webhook payload — stable, and documented as the contract. */
export function toWebhook(event: FleetEventPayload) {
  return {
    type: event.type,
    severity: severityOf(event.type),
    fleet_id: event.fleetId,
    subject: event.subject,
    message: headline(event),
    at: event.at,
    detail: event.detail ?? {},
  }
}

const HTML_ESC: Record<string, string> = {
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}
const esc = (s: string) => String(s).replace(/[&<>"']/g, (c) => HTML_ESC[c]!)

const HEX: Record<Severity, string> = {
  info: '#0b8f4d',
  warning: '#9a5b00',
  critical: '#c0392b',
}

const SANS = "ui-sans-serif,-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif"
const MONO = 'ui-monospace,SFMono-Regular,Menlo,Consolas,monospace'

/**
 * The subject line is what decides whether an alert is read on a phone at
 * midnight, so it leads with the thing that changed rather than the product
 * name. Critical events say so; routine ones stay quiet.
 */
function subjectFor(event: FleetEventPayload): string {
  const sev = severityOf(event.type)
  const prefix = sev === 'critical' ? '[fleet-os] ACTION NEEDED' : '[fleet-os]'
  return `${prefix} ${headline(event)}`
}

/**
 * A real email rather than a wall of key: value lines.
 *
 * Every alert channel had a considered format except this one - Discord and
 * Slack got embeds and colour, and email got a text dump. Deploy notifications
 * are the ones people actually receive daily, so they are the ones worth
 * making legible.
 *
 * Plain text is returned alongside, because the sender ships both parts and a
 * text-only fallback is what several clients will render.
 */
export function toEmail(event: FleetEventPayload): { subject: string; body: string } {
  const rows = fields(event)
  const sev = severityOf(event.type)
  const colour = HEX[sev]

  const table = rows.length
    ? `<table cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:18px 0;width:100%">` +
      rows
        .map(
          ([k, v]) =>
            `<tr>` +
            `<td style="padding:7px 16px 7px 0;border-bottom:1px solid #eef0f3;color:#838c98;` +
            `font:11px/1.4 ${MONO};letter-spacing:.1em;text-transform:uppercase;white-space:nowrap;vertical-align:top">${esc(k)}</td>` +
            `<td style="padding:7px 0;border-bottom:1px solid #eef0f3;color:#12161b;font:13.5px/1.5 ${MONO};word-break:break-word">${esc(v)}</td>` +
            `</tr>`
        )
        .join('') +
      `</table>`
    : ''

  const url = typeof event.detail?.url === 'string' ? event.detail.url : null
  const link = url
    ? `<p style="margin:0 0 14px"><a href="${esc(url.startsWith('http') ? url : `https://${url}`)}" ` +
      `style="color:${colour};font:13.5px/1.5 ${MONO};word-break:break-all">${esc(url)}</a></p>`
    : ''

  const body =
    `<div style="font:14px/1.65 ${SANS};color:#12161b;max-width:560px;padding:8px">` +
    `<div style="font:600 12px/1 ${MONO};letter-spacing:.16em;text-transform:uppercase;color:${colour};margin-bottom:18px">` +
    `fleet&middot;os &nbsp;/&nbsp; ${esc(sev)}</div>` +
    // A left rule in the severity colour, so the seriousness reads before
    // any of the words do.
    `<div style="border-left:3px solid ${colour};padding-left:14px">` +
    `<div style="font-size:17px;font-weight:600;letter-spacing:-.02em;line-height:1.35">${esc(headline(event))}</div>` +
    `</div>` +
    table +
    link +
    `<div style="margin-top:20px;padding-top:12px;border-top:1px solid #e3e6ea;color:#838c98;font:11.5px/1.6 ${MONO}">` +
    `${esc(event.type)} &middot; fleet ${esc(event.fleetId)}<br>${esc(event.at)}</div>` +
    `</div>`

  return { subject: subjectFor(event), body }
}

/** The same content as plain text, for anywhere HTML is not wanted. */
export function toEmailText(event: FleetEventPayload): string {
  return [
    headline(event),
    '',
    ...fields(event).map(([k, v]) => `${k}: ${v}`),
    '',
    `Event: ${event.type}`,
    `Fleet: ${event.fleetId}`,
    `Time:  ${event.at}`,
  ].join('\n')
}

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

export function toEmail(event: FleetEventPayload): { subject: string; body: string } {
  const extra = fields(event)
  return {
    subject: `[fleet-os] ${headline(event)}`,
    body: [
      headline(event),
      '',
      ...extra.map(([k, v]) => `${k}: ${v}`),
      '',
      `Event: ${event.type}`,
      `Fleet: ${event.fleetId}`,
      `Time:  ${event.at}`,
    ].join('\n'),
  }
}

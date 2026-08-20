/**
 * The vocabulary of things that happen to a fleet. Alert rules subscribe to
 * these by name (PRD 7.6), so the strings are part of the public contract —
 * renaming one silently breaks a user's alert routing.
 */
export const FLEET_EVENTS = [
  'node.registered',
  'node.online',
  'node.down',
  'node.cordoned',
  'node.drained',
  'node.removed',
  'deploy.started',
  'deploy.succeeded',
  'deploy.failed',
  'deploy.rolled_back',
  'service.rescheduled',
  'service.pinned_unavailable',
  'service.crash_looping',
  'volume.flexible_warning',
  'drift.detected',
] as const

export type FleetEvent = (typeof FLEET_EVENTS)[number]

export type FleetEventPayload = {
  type: FleetEvent
  fleetId: string
  at: string
  subject: string
  detail?: Record<string, unknown>
}

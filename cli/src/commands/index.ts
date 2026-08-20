import type { Flags } from '../args.js'
import { authCommand } from './auth.js'
import { nodesCommand } from './nodes.js'
import { statusCommand, eventsCommand } from './status.js'
import { alertsCommand } from './alerts.js'
import {
  applyCommand,
  deployCommand,
  deploymentsCommand,
  initCommand,
  rescheduleCommand,
  servicesCommand,
  validateCommand,
  whereCommand,
} from './services.js'

export type Command = { run(args: string[], flags: Flags): Promise<void> }

export const commands: Record<string, Command> = {
  auth: authCommand,
  init: initCommand,
  validate: validateCommand,
  apply: applyCommand,
  status: statusCommand,
  nodes: nodesCommand,
  services: servicesCommand,
  deploy: deployCommand,
  where: whereCommand,
  reschedule: rescheduleCommand,
  deployments: deploymentsCommand,
  events: eventsCommand,
  alerts: alertsCommand,
}

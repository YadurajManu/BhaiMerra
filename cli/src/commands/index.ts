import type { Flags } from '../args.js'
import { authCommand } from './auth.js'
import { nodesCommand } from './nodes.js'
import { statusCommand, eventsCommand } from './status.js'
import { alertsCommand } from './alerts.js'
import { configCommand, useCommand } from './config.js'
import { doctorCommand } from './doctor.js'
import { upCommand } from './up.js'
import { openCommand } from './open.js'
import { downCommand } from './down.js'
import { unpairCommand, agentCommand } from './unpair.js'
import { secretsCommand } from './secrets.js'
import { backupCommand, backupsCommand, restoreCommand } from './backups.js'
import {
  applyCommand,
  deployCommand,
  deploymentsCommand,
  initCommand,
  importCommand,
  logsCommand,
  removeServiceCommand,
  restartCommand,
  rollbackCommand,
  rescheduleCommand,
  servicesCommand,
  validateCommand,
  whereCommand,
} from './services.js'

export type Command = { run(args: string[], flags: Flags): Promise<void> }

export const commands: Record<string, Command> = {
  up: upCommand,
  open: openCommand,
  down: downCommand,
  rm: removeServiceCommand,
  auth: authCommand,
  config: configCommand,
  use: useCommand,
  doctor: doctorCommand,
  init: initCommand,
  import: importCommand,
  validate: validateCommand,
  apply: applyCommand,
  status: statusCommand,
  nodes: nodesCommand,
  services: servicesCommand,
  deploy: deployCommand,
  where: whereCommand,
  reschedule: rescheduleCommand,
  deployments: deploymentsCommand,
  logs: logsCommand,
  restart: restartCommand,
  rollback: rollbackCommand,
  events: eventsCommand,
  alerts: alertsCommand,
  secrets: secretsCommand,
  backup: backupCommand,
  backups: backupsCommand,
  restore: restoreCommand,
  unpair: unpairCommand,
  agent: agentCommand,
}


#!/usr/bin/env node
import { pathToFileURL } from 'node:url'
import { CliError, EXIT } from './api.js'
import { c } from './render.js'
import { commands, type Command } from './commands/index.js'
import { parseArgs, type Flags } from './args.js'

export type { Flags }
export { parseArgs }

const USAGE = `${c.bold('fleet')} — deploy to hardware you own

${c.dim('USAGE')}
  fleet <command> [options]

${c.dim('COMMANDS')}
  auth login|logout|whoami   Sign in to a control plane
  init                       Scaffold a fleet.yaml from this repository
  validate [file]            Check a fleet.yaml without applying it
  apply [file]               Apply a fleet.yaml to the fleet
  status                     One-screen view of the whole fleet
  nodes                      List nodes
  nodes pair                 Mint a pairing token for a new machine
  nodes cordon <name>        Stop scheduling new work onto a node
  nodes uncordon <name>      Allow scheduling again
  nodes rm <name>            Revoke and remove a node
  services                   List services and where they are running
  deploy <service>           Build if needed, schedule, and roll out
  where <service>            Explain where a service would be placed, and why
  reschedule <service>       Force a service to move
  deployments <service>      Deployment history
  events                     Unified event timeline
  alerts                     List alert rules
  alerts add                 Add a webhook/discord/slack/email rule
  alerts test                Fire a sample alert to verify routing

${c.dim('GLOBAL OPTIONS')}
  --fleet <id>   Operate on a specific fleet
  --api <url>    Control plane URL (default: saved profile)
  --json         Machine-readable output
  -h, --help     Show help

${c.dim('EXIT CODES')}
  0 ok   1 failure   2 usage   3 no eligible node   4 health check failed
`

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2))
  const [name, ...rest] = positional

  if (!name || flags.help || flags.h) {
    console.log(USAGE)
    process.exit(name ? EXIT.ok : EXIT.usage)
  }

  const command: Command | undefined = commands[name]
  if (!command) {
    const near = Object.keys(commands).filter((k) => k.startsWith(name[0] ?? ''))
    console.error(
      `${c.red('unknown command')} "${name}"` + (near.length ? `\n  did you mean: ${near.join(', ')}?` : '')
    )
    process.exit(EXIT.usage)
  }

  await command.run(rest, flags)
}

/**
 * Only run when invoked as a command. Importing the entrypoint — from a test,
 * or another tool — must not execute it.
 */
const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href

if (invokedDirectly) {
  main().catch(onError)
}

function onError(err: unknown) {
  if (err instanceof CliError) {
    console.error(`${c.red('error')}  ${err.message}`)
    if (err.detail) {
      const lines = Array.isArray(err.detail) ? err.detail : [err.detail]
      for (const line of lines) {
        console.error(
          '  ' +
            (typeof line === 'string'
              ? line
              : `${(line as { path?: string }).path ?? ''} ${(line as { message?: string }).message ?? JSON.stringify(line)}`)
        )
      }
    }
    process.exit(err.exitCode)
  }
  console.error(`${c.red('error')}  ${err instanceof Error ? err.message : String(err)}`)
  process.exit(EXIT.failure)
}

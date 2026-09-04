#!/usr/bin/env node
import { pathToFileURL } from 'node:url'
import { realpathSync } from 'node:fs'
import { CliError, EXIT } from './api.js'
import { c } from './render.js'
import { banner } from './mark.js'
import { commands, type Command } from './commands/index.js'
import { parseArgs, type Flags } from './args.js'

export type { Flags }
export { parseArgs }

/**
 * Grouped by the order an operator meets them, not alphabetically: the first
 * group is a first session with the tool, read top to bottom.
 */
const GROUPS: Array<[string, Array<[string, string]>]> = [
  [
    'getting started',
    [
      ['up [service]', 'Deploy the whole fleet.yaml, in dependency order'],
      ['init', 'Read the repository — monorepo, databases, secrets — and write a fleet.yaml'],
      ['init --ai', 'The same, then have the control plane review the draft against the repository'],
      ['import [file]', 'Convert a docker-compose.yml into a fleet.yaml'],
      ['config show', 'Show the saved control plane and selected fleet'],
      ['use <fleet>', 'Select the default fleet for later commands'],
      ['auth login', 'Sign in and save a secure local session'],
      ['nodes pair', 'Mint a pairing token for a new machine'],
      ['doctor', 'Check the control plane, nodes, services, ingress, and GitHub'],
      ['apply [file]', 'Apply a fleet.yaml to the fleet'],
      ['deploy <service>', 'Build, schedule, and roll out'],
      ['explain <service>', 'Read a failed deploy and say what to do about it'],
    ],
  ],
  [
    'looking around',
    [
      ['open [service]', 'Open the live service in your default browser'],
      ['status', 'One-screen view of the whole fleet'],
      ['services', 'List services and where they are running'],
      ['nodes', 'List nodes'],
      ['where <service>', 'Explain where a service would be placed, and why'],
      ['deployments <service>', 'Deployment history'],
      ['logs <service> --follow', 'Follow the latest agent-reported container tail'],
      ['events', 'Unified event timeline'],
    ],
  ],
  [
    'operating',
    [
      ['down <service>', 'Stop and tear down a service deployment'],
      ['rm <service>', 'Permanently delete a service from the fleet'],
      ['validate [file]', 'Check a fleet.yaml without applying it'],
      ['reschedule <service>', 'Force a service to move'],
      ['restart <service>', 'Replace the current release on its node'],
      ['rollback <service> [release]', 'Restore the previous or selected release'],
      ['secrets', 'List the fleet secret store'],
      ['secrets set <KEY>', 'Store a credential; the value is never echoed or logged'],
      ['secrets import [.env]', 'Store the secrets fleet.yaml declares, read from a .env file'],
      ['secrets rm <KEY>', 'Remove a stored credential'],
      ['backup <service>', "Copy a service's volume off the node holding it"],
      ['backups <service>', 'List backups, newest first'],
      ['restore <service> [id]', 'Write a backup back into the volume; service must be stopped'],
      ['nodes cordon <name>', 'Stop scheduling new work onto a node'],
      ['nodes uncordon <name>', 'Allow scheduling again'],
      ['nodes rm <name>', 'Revoke and remove a node'],
      ['unpair', 'Remove this machine from its fleet, run on the machine'],
      ['alerts', 'List, add, and test alert rules'],
      ['auth login|logout|whoami', 'Sign in to a control plane'],
      ['auth forgot|reset', 'Recover an account you are locked out of'],
    ],
  ],
]

const OPTIONS: Array<[string, string]> = [
  ['--fleet <id>', 'Operate on a specific fleet'],
  ['--api <url>', 'Control plane URL (default: saved profile)'],
  ['--json', 'Machine-readable output on stdout'],
  ['--plan, --dry-run', 'Show the deploy placement plan without changing anything'],
  ['--yes', 'Skip the interactive deploy confirmation'],
  ['--no-wait', 'Return once scheduled, without following the rollout'],
  ['-h, --help', 'Show help'],
]

// One column width across every group, so the glosses form a single edge down
// the page rather than stepping in and out per section.
const TERM_WIDTH = Math.max(
  ...GROUPS.flatMap(([, rows]) => rows.map(([term]) => term.length)),
  ...OPTIONS.map(([term]) => term.length)
)

const definitions = (rows: Array<[string, string]>): string =>
  rows.map(([term, gloss]) => `  ${term.padEnd(TERM_WIDTH)}   ${c.dim(gloss)}`).join('\n')

const usage = (): string =>
  [
    banner('deploy to hardware you own'),
    '',
    `${c.dim('usage')}  fleet <command> [options]`,
    ...GROUPS.flatMap(([title, rows]) => ['', c.bold(title), definitions(rows)]),
    '',
    c.bold('options'),
    definitions(OPTIONS),
    '',
    c.dim('exit codes  0 ok · 1 failure · 2 usage · 3 no eligible node · 4 health check failed'),
    '',
  ].join('\n')

async function version(): Promise<string> {
  const { readFile } = await import('node:fs/promises')
  const path = new URL('../package.json', import.meta.url)
  const pkg = JSON.parse(await readFile(path, 'utf8')) as { version?: string }
  return pkg.version ?? '0.0.0'
}

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2))
  const [name, ...rest] = positional

  if (flags.version || flags.v) {
    console.log(await version())
    process.exit(EXIT.ok)
  }

  if (!name || flags.help || flags.h) {
    console.log(usage())
    // A bare `fleet` is someone asking what this is, not a malformed command.
    process.exit(EXIT.ok)
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
  // npm link exposes the bin as a symlink. ESM resolves this module to its
  // real path, whereas argv retains the symlink, so compare canonical paths.
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href

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

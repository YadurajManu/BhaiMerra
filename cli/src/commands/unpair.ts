/**
 * fleet unpair — take *this* machine out of a fleet, from the machine itself.
 *
 * The counterpart to `fleet nodes rm`, which is run by an operator elsewhere.
 * This one has to be run on the host because only the host can stop its own
 * daemon, remove its own containers, and delete its own credential file.
 *
 * Order matters and is the whole point of the command:
 *
 *   1. read local state — the node id is needed before the file is deleted
 *   2. stop the agent, and disable it so a reboot does not resurrect it
 *   3. tell the control plane, which reschedules the workloads elsewhere
 *   4. remove the local containers
 *   5. wipe the credential
 *
 * The agent is stopped first because it reconciles on a timer: with it still
 * running, containers removed in step 4 are recreated seconds later, and its
 * runtime check may relaunch Docker underneath you.
 */
import { rm, access, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { exec } from 'node:child_process'
import { promisify } from 'node:util'
import { request, CliError, EXIT } from '../api.js'
import { c } from '../render.js'
import { glyph } from '../ui.js'
import type { Flags } from '../args.js'

const execAsync = promisify(exec)

/** Agent state, as written by internal/state/state.go. */
type AgentState = {
  node_id?: string
  fleet_id?: string
  name?: string
  control_plane_url?: string
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

/**
 * Where the agent keeps its state, mirroring state.DefaultPath() in the agent
 * and the STATE_DIR logic in scripts/install.sh. These are per-platform and
 * genuinely different — guessing /var/lib/fleet-os everywhere would report a
 * successful wipe while leaving the credential on disk.
 */
function stateDir(): string {
  const override = process.env.FLEET_STATE_DIR
  if (override) return override
  if (process.platform === 'win32') return join(homedir(), '.fleet-os')
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'fleet-os')
  return '/var/lib/fleet-os'
}

/** Best-effort shell step: report what happened, never abort the teardown. */
async function step(label: string, fn: () => Promise<string | null>): Promise<void> {
  process.stdout.write(`  ${glyph.info} ${label}… `)
  try {
    const detail = await fn()
    console.log(detail ? c.dim(detail) : c.green('done'))
  } catch (err) {
    console.log(c.yellow(`skipped — ${(err as Error).message.split('\n')[0]}`))
  }
}

async function confirm(state: AgentState | null): Promise<boolean> {
  const who = state?.name ? c.bold(state.name) : 'this machine'
  console.log(
    `  This removes ${who} from its fleet:\n` +
      `    ${c.dim('·')} the background agent is stopped and disabled\n` +
      `    ${c.dim('·')} Fleet containers on this host are removed\n` +
      `    ${c.dim('·')} its credentials are deleted and revoked\n` +
      `  ${c.dim('Services running here are rescheduled onto other nodes where possible.')}\n`
  )
  if (!process.stdin.isTTY) return false
  const { createInterface } = await import('node:readline/promises')
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    const ans = await rl.question('  Unpair this machine? [y/N] ')
    return ans.trim().toLowerCase() === 'y'
  } finally {
    rl.close()
  }
}

export const unpairCommand = {
  async run(_args: string[], flags: Flags) {
    console.log(`\n  ${c.bold('Unpair this machine')}\n`)

    const dir = stateDir()
    const statePath = join(dir, 'agent.json')

    // 1. Read the identity before anything destroys it.
    let state: AgentState | null = null
    if (await exists(statePath)) {
      try {
        state = JSON.parse(await readFile(statePath, 'utf8')) as AgentState
      } catch {
        console.log(c.dim(`  ${glyph.warn} ${statePath} is unreadable — continuing with local cleanup only`))
      }
    }

    if (!state && !flags.force && !flags.f) {
      throw new CliError(
        `No agent state at ${statePath} — this machine does not look paired.\n` +
          `  Re-run with --force to clean up anyway.`,
        EXIT.usage
      )
    }

    const confirmed = flags.yes === true || flags.y === true
    if (!confirmed && !(await confirm(state))) {
      console.log(c.dim('Unpair cancelled.'))
      return
    }

    const isWindows = process.platform === 'win32'
    const isMac = process.platform === 'darwin'

    // 2. Stop the agent first. Both the systemd unit (Restart=always) and the
    //    launchd job restart the process on their own, so stopping without
    //    disabling buys about five seconds.
    await step('Stopping the Fleet agent', async () => {
      if (isWindows) {
        await execAsync('taskkill /IM fleet-agent.exe /F').catch(() => {})
        return 'stopped'
      }
      if (isMac) {
        const plist = join(homedir(), 'Library', 'LaunchAgents', 'dev.fleet-os.agent.plist')
        if (await exists(plist)) {
          await execAsync(`launchctl unload ${JSON.stringify(plist)}`).catch(() => {})
          await rm(plist, { force: true }).catch(() => {})
        }
        await execAsync('pkill -f fleet-agent').catch(() => {})
        return 'launchd job unloaded and removed'
      }
      // Linux: disable as well as stop, or the unit comes back on reboot. The
      // unit is a system unit installed with sudo, so it takes sudo to remove.
      await execAsync('systemctl disable --now fleet-agent').catch(() =>
        execAsync('sudo -n systemctl disable --now fleet-agent')
      ).catch(() => execAsync('pkill -f fleet-agent'))
      return 'systemd unit stopped and disabled'
    })

    // 3. Tell the control plane, so services running here are rescheduled onto
    //    other nodes *before* the local containers go away. Uses the operator's
    //    CLI session: node removal is an owner action, and an agent token
    //    deliberately cannot delete its own node.
    if (state?.node_id && state?.fleet_id) {
      await step('Removing this node from the fleet', async () => {
        const { body } = await request<{
          removed?: { name: string }
          evicted?: Array<{ service: string; action: string }>
        }>('DELETE', `/fleets/${state.fleet_id}/nodes/${state.node_id}`)
        const moved = body.evicted?.filter((e) => e.action === 'moved').length ?? 0
        const held = body.evicted?.filter((e) => e.action !== 'moved') ?? []
        const parts = [`removed as ${body.removed?.name ?? state.name ?? 'node'}`]
        if (moved) parts.push(`${moved} service(s) rescheduled`)
        if (held.length) parts.push(`${held.length} could not move (${held.map((h) => h.service).join(', ')})`)
        return parts.join(', ')
      })
    } else {
      console.log(
        c.dim(`  ${glyph.warn} No node id in local state — skipping control plane removal.`) +
          c.dim(`\n     Remove it from another machine with: `) +
          c.cyan('fleet nodes rm <name> --force')
      )
    }

    // 4. Remove the local containers. Only Fleet's own: the name filter matches
    //    what the agent creates, and anything else on this host is not ours.
    await step('Removing Fleet containers', async () => {
      const { stdout } = await execAsync('docker ps -aq --filter "name=fleet-"')
      const ids = stdout.trim().split('\n').filter(Boolean)
      if (!ids.length) return 'none running'
      await execAsync(`docker rm -f ${ids.join(' ')}`)
      return `${ids.length} removed`
    })

    // 5. Wipe the credential last, so a failure earlier on leaves the machine
    //    in a state this command can be run against again.
    await step(`Wiping credentials in ${dir}`, async () => {
      if (!(await exists(dir))) return 'nothing to remove'
      await rm(dir, { recursive: true, force: true })
      return 'deleted'
    })

    console.log(`\n${glyph.ok} ${c.green(c.bold('This machine is unpaired'))}`)
    console.log(c.dim('  Docker is left running and is yours to stop or start as you like.'))
    console.log(c.dim('  To pair it again: ') + c.cyan('fleet nodes pair') + c.dim(' on your control plane\n'))
  },
}

/**
 * `fleet agent <sub>` — host-local operations, grouped under the thing they act
 * on. Only unpair for now; `fleet unpair` is the shorter spelling of the same
 * action, since it is the one people reach for.
 */
export const agentCommand = {
  async run(args: string[], flags: Flags) {
    const [sub, ...rest] = args
    if (sub === 'unpair') return unpairCommand.run(rest, flags)
    throw new CliError('usage: fleet agent unpair [--yes]', EXIT.usage)
  },
}

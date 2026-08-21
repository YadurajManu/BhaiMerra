import { CliError, EXIT, request } from '../api.js'
import { loadProfile, saveProfile } from '../config.js'
import { c, keyValues } from '../render.js'
import { glyph, rule, task } from '../ui.js'
import type { Flags } from '../args.js'

type FleetSummary = { id: string; name: string; role: string }

/** Keep credentials out of normal command output and screen recordings. */
function profileRows(profile: Awaited<ReturnType<typeof loadProfile>>): Array<[string, string]> {
  return [
    ['control plane', profile.api || c.yellow('not configured')],
    ['fleet', profile.fleetName ?? profile.fleetId ?? c.yellow('not selected')],
    ['signed in', profile.accessToken ? c.green('yes') : c.yellow('no')],
  ]
}

export const configCommand = {
  async run(args: string[], flags: Flags) {
    const [sub = 'show'] = args
    if (sub !== 'show') throw new CliError('usage: fleet config show', EXIT.usage)

    const profile = await loadProfile()
    if (flags.json) {
      return console.log(
        JSON.stringify(
          {
            api: profile.api || null,
            fleetId: profile.fleetId ?? null,
            fleetName: profile.fleetName ?? null,
            signedIn: Boolean(profile.accessToken),
          },
          null,
          2
        )
      )
    }
    console.log(keyValues(profileRows(profile)))
  },
}

export const useCommand = {
  async run(args: string[], flags: Flags) {
    const [target] = args
    if (!target) throw new CliError('usage: fleet use <fleet-name-or-id>', EXIT.usage)

    const profile = await loadProfile()
    const fleets = await task('finding fleets you can access', async () =>
      (await request<{ fleets: FleetSummary[] }>('GET', '/fleets')).body.fleets
    )
    const matches = fleets.filter((fleet) => fleet.id === target || fleet.id.startsWith(target) || fleet.name === target)
    if (!matches.length) {
      throw new CliError(
        `No fleet called "${target}". Available: ${fleets.map((fleet) => fleet.name).join(', ') || 'none'}`,
        EXIT.usage
      )
    }
    if (matches.length > 1) {
      throw new CliError(`"${target}" is ambiguous. Use one of:\n${matches.map((f) => `  ${f.name}  ${f.id}`).join('\n')}`, EXIT.usage)
    }

    const fleet = matches[0]!
    await saveProfile({ ...profile, fleetId: fleet.id, fleetName: fleet.name })
    if (flags.json) return console.log(JSON.stringify({ fleet }, null, 2))
    console.log(`${glyph.ok} using ${c.signal(fleet.name)}  ${c.dim(`${fleet.role} · ${fleet.id}`)}`)
  },
}

export { profileRows }

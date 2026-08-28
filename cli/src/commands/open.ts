/**
 * fleet open [service] — opens the deployed service in your default browser.
 *
 * Discovers the public HTTPS URL for the service and launches it via the
 * platform's native opener (open on macOS, xdg-open on Linux, start on Windows).
 */
import { exec } from 'node:child_process'
import { promisify } from 'node:util'
import { request, requireFleet, CliError, EXIT } from '../api.js'
import { c } from '../render.js'
import { glyph } from '../ui.js'
import type { Flags } from '../args.js'

const execAsync = promisify(exec)

type Service = {
  id: string
  name: string
  domain: string | null
  hostname: string | null
}

async function openUrl(url: string): Promise<void> {
  const platform = process.platform
  let cmd = ''
  if (platform === 'darwin') {
    cmd = `open "${url}"`
  } else if (platform === 'win32') {
    cmd = `start "" "${url}"`
  } else {
    cmd = `xdg-open "${url}"`
  }

  try {
    await execAsync(cmd)
  } catch (err) {
    throw new CliError(`Could not open browser automatically: ${String(err)}`, EXIT.failure)
  }
}

export const openCommand = {
  async run(args: string[], flags: Flags) {
    const fleetId = await requireFleet(typeof flags.fleet === 'string' ? flags.fleet : undefined)
    const [nameArg] = args

    const { body } = await request<{ services: Service[] }>('GET', `/fleets/${fleetId}/services`)
    if (!body.services.length) {
      throw new CliError('No services in this fleet. Run `fleet up` to deploy one.', EXIT.usage)
    }

    let service: Service | undefined
    if (nameArg) {
      service = body.services.find((s) => s.name === nameArg || s.id === nameArg)
      if (!service) {
        throw new CliError(
          `No service called "${nameArg}". Known: ${body.services.map((s) => s.name).join(', ')}`,
          EXIT.usage
        )
      }
    } else {
      // If only one service exists, pick it. Otherwise ask user to specify.
      if (body.services.length === 1) {
        service = body.services[0]
      } else {
        throw new CliError(
          `Multiple services available. Specify which to open:\n` +
            body.services.map((s) => `  fleet open ${s.name}`).join('\n'),
          EXIT.usage
        )
      }
    }

    const rawUrl = service!.domain ?? service!.hostname
    if (!rawUrl) {
      throw new CliError(`Service "${service!.name}" does not have an assigned URL yet.`, EXIT.usage)
    }

    const url = rawUrl.startsWith('http') ? rawUrl : `https://${rawUrl}`
    console.log(`${glyph.ok} opening ${c.bold(service!.name)} ${c.dim('→')} ${c.cyan(url)}`)
    await openUrl(url)
  },
}

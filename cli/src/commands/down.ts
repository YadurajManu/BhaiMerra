/**
 * fleet down <service> — cleanly stops and tears down a running service deployment.
 *
 * Marks active deployments as stopped and instructs the assigned node agent
 * to unassign and remove the container on its next reconciliation cycle.
 */
import { request, requireFleet, CliError, EXIT } from '../api.js'
import { c } from '../render.js'
import { glyph } from '../ui.js'
import type { Flags } from '../args.js'

type Service = {
  id: string
  name: string
  current: { status: string; nodeName: string | null } | null
}

async function confirmTeardown(name: string): Promise<boolean> {
  if (!process.stdin.isTTY) return true
  const { createInterface } = await import('node:readline/promises')
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    const ans = await rl.question(`  Stop and tear down ${c.bold(name)}? [y/N] `)
    return ans.trim().toLowerCase() === 'y'
  } finally {
    rl.close()
  }
}

export const downCommand = {
  async run(args: string[], flags: Flags) {
    const fleetId = await requireFleet(typeof flags.fleet === 'string' ? flags.fleet : undefined)
    const [name] = args
    if (!name) throw new CliError('usage: fleet down <service> [--yes]', EXIT.usage)

    const { body: listBody } = await request<{ services: Service[] }>('GET', `/fleets/${fleetId}/services`)
    const service = listBody.services.find((s) => s.name === name || s.id === name)
    if (!service) {
      throw new CliError(
        `No service called "${name}". Known: ${listBody.services.map((s) => s.name).join(', ') || 'none'}`,
        EXIT.usage
      )
    }

    if (!flags.yes && !flags.y && !(await confirmTeardown(service.name))) {
      console.log(c.dim('Teardown cancelled.'))
      return
    }

    const { body } = await request<{
      stopped: number
      service: string
      note?: string
      message?: string
    }>('POST', `/services/${service.id}/stop`, { body: {} })

    if (flags.json) return console.log(JSON.stringify(body, null, 2))

    if (body.stopped === 0) {
      console.log(`${glyph.info} ${body.message ?? `"${service.name}" is not currently running.`}`)
      return
    }

    console.log(`${glyph.ok} ${c.yellow('stopped')}  ${c.bold(service.name)}`)
    if (body.note) {
      console.log(c.dim(`  ${body.note}`))
    }
  },
}

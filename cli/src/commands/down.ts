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

/**
 * Say what teardown actually does before doing it.
 *
 * The distinction people get wrong is `down` versus `rm`, so the prompt names it:
 * the container goes, the service definition stays and can be redeployed. Where
 * it is running is included because that is the machine whose Docker is about to
 * change, and it is usually not the one this command is typed on.
 *
 * Non-interactive callers are taken as consenting. That is deliberate and is not
 * how `rm` behaves — stopping a service is undone by deploying it again, so a
 * scripted `fleet down` in a CI teardown step should not need --yes.
 */
async function confirmTeardown(service: Service): Promise<boolean> {
  if (!process.stdin.isTTY) return true
  const where = service.current?.nodeName
  console.log(
    `\n  This stops ${c.bold(service.name)}${where ? ` on ${c.bold(where)}` : ''}:` +
      `\n    ${c.dim('·')} its container is removed from that machine` +
      `\n    ${c.dim('·')} the service definition is kept, so ${c.cyan('fleet deploy')}${c.dim(' brings it back')}` +
      `\n  ${c.dim('To delete it outright, use `fleet rm` instead.')}\n`
  )
  const { createInterface } = await import('node:readline/promises')
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    const ans = await rl.question(`  Stop and tear down ${c.bold(service.name)}? [y/N] `)
    return ans.trim().toLowerCase() === 'y'
  } finally {
    rl.close()
  }
}

export const downCommand = {
  async run(args: string[], flags: Flags) {
    // Before requireFleet, which reaches the control plane when no fleet is
    // saved: a missing argument should not need the network to be reported.
    const [name] = args
    if (!name) throw new CliError('usage: fleet down <service> [--yes]', EXIT.usage)

    const fleetId = await requireFleet(typeof flags.fleet === 'string' ? flags.fleet : undefined)

    const { body: listBody } = await request<{ services: Service[] }>('GET', `/fleets/${fleetId}/services`)
    const service = listBody.services.find((s) => s.name === name || s.id === name)
    if (!service) {
      throw new CliError(
        `No service called "${name}". Known: ${listBody.services.map((s) => s.name).join(', ') || 'none'}`,
        EXIT.usage
      )
    }

    if (!flags.yes && !flags.y && !(await confirmTeardown(service))) {
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

import { request, requireFleet, CliError, EXIT } from '../api.js'
import { c, table } from '../render.js'
import type { Flags } from '../args.js'

export const alertsCommand = {
  async run(args: string[], flags: Flags) {
    const fleetId = await requireFleet(typeof flags.fleet === 'string' ? flags.fleet : undefined)
    const [sub] = args

    if (!sub || sub === 'ls' || sub === 'list') {
      const { body } = await request<{
        rules: Array<{ id: string; channelType: string; eventTypes: string[]; enabled: boolean; target: string }>
      }>('GET', `/fleets/${fleetId}/alert-rules`)

      if (flags.json) return console.log(JSON.stringify(body.rules, null, 2))
      if (!body.rules.length) {
        console.log('No alert rules. Failover will happen silently — add one with `fleet alerts add`.')
        return
      }
      console.log(
        table(
          ['channel', 'target', 'events', 'enabled'],
          body.rules.map((r) => [
            r.channelType,
            r.target,
            r.eventTypes.length ? r.eventTypes.join(', ') : c.dim('everything'),
            r.enabled ? c.green('yes') : c.dim('no'),
          ])
        )
      )
      return
    }

    if (sub === 'add') {
      const channelType = typeof flags.channel === 'string' ? flags.channel : 'webhook'
      const url = typeof flags.url === 'string' ? flags.url : undefined
      const to = typeof flags.to === 'string' ? flags.to : undefined
      const secret = typeof flags.secret === 'string' ? flags.secret : undefined
      const eventTypes =
        typeof flags.events === 'string' ? flags.events.split(',').map((s) => s.trim()) : []

      if (!url && !to) {
        throw new CliError(
          'usage: fleet alerts add --channel webhook|discord|slack --url <url> [--secret <s>]\n' +
            '       fleet alerts add --channel email --to you@example.com',
          EXIT.usage
        )
      }

      await request('POST', `/fleets/${fleetId}/alert-rules`, {
        body: { channelType, url, to, secret, eventTypes },
      })
      console.log(`${c.green('added')} ${channelType} alert rule`)
      console.log(c.dim('  verify it with `fleet alerts test` before you need it'))
      return
    }

    if (sub === 'test') {
      const { body } = await request<{ delivered: number; results: Array<{ channel: string; ok: boolean; error?: string }> }>(
        'POST',
        `/fleets/${fleetId}/alert-rules/test`
      )
      if (!body.results.length) return console.log('no alert rules to test')
      for (const r of body.results) {
        console.log(r.ok ? `${c.green('ok')}    ${r.channel}` : `${c.red('fail')}  ${r.channel}  ${r.error}`)
      }
      if (body.delivered !== body.results.length) process.exit(EXIT.failure)
      return
    }

    throw new CliError('usage: fleet alerts [ls|add|test]', EXIT.usage)
  },
}

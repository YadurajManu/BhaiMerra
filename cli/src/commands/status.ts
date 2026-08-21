import { request, requireFleet } from '../api.js'
import { c, table, statusColour, mb, relativeTime } from '../render.js'
import type { Flags } from '../args.js'

type MapNode = {
  name: string
  arch: string
  status: string
  reliabilityTier: string
  ramMb: number
  freeRamMb: number
  loadFactor: number | null
  services: Array<{ name: string; policy: string; status: string }>
}

/**
 * One screen that answers "is my fleet fine?" — the command people will run
 * most, so it leads with what is wrong rather than burying it in a table.
 */
export const statusCommand = {
  async run(_args: string[], flags: Flags) {
    const fleetId = await requireFleet(typeof flags.fleet === 'string' ? flags.fleet : undefined)
    const [map, events] = await Promise.all([
      request<{ nodes: MapNode[]; unplaced: string[] }>('GET', `/fleets/${fleetId}/placement-map`),
      request<{ events: Array<{ at: string; service: string; reason: string; from: string | null; to: string | null }> }>(
        'GET',
        `/fleets/${fleetId}/events?limit=5`
      ),
    ])

    if (flags.json) {
      return console.log(JSON.stringify({ nodes: map.body.nodes, events: events.body.events }, null, 2))
    }

    const nodes = map.body.nodes
    const offline = nodes.filter((n) => n.status === 'offline')
    const pinnedDown = nodes.flatMap((n) =>
      n.services.filter((s) => s.status === 'pinned_unavailable').map((s) => ({ node: n.name, service: s.name }))
    )

    if (!nodes.length) {
      console.log('No nodes in this fleet yet.')
      console.log(c.dim('  Run `fleet nodes pair` and install the agent on a machine you own.'))
      return
    }

    // Anything needing a human goes first, in the colour that says so.
    if (pinnedDown.length) {
      for (const p of pinnedDown) {
        console.log(
          `${c.red('CRITICAL')}  ${c.bold(p.service)} is down and was not moved — pinned to ${p.node}`
        )
      }
      console.log()
    } else if (offline.length) {
      console.log(`${c.yellow('degraded')}  ${offline.map((n) => n.name).join(', ')} offline\n`)
    } else {
      console.log(`${c.green('healthy')}  ${nodes.length} node(s), all reporting\n`)
    }

    console.log(
      table(
        ['node', 'arch', 'tier', 'free ram', 'load', 'services', 'status'],
        nodes.map((n) => [
          n.name,
          n.arch,
          n.reliabilityTier,
          `${mb(n.freeRamMb)}/${mb(n.ramMb)}`,
          n.loadFactor === null ? c.dim('—') : `${Math.round(n.loadFactor * 100)}%`,
          n.services.length
            ? n.services
                .map((s) =>
                  s.status === 'pinned_unavailable' ? c.red(s.name) : s.policy === 'pinned' ? c.yellow(s.name) : s.name
                )
                .join(' ')
            : c.dim('—'),
          statusColour(n.status),
        ])
      )
    )

    if (map.body.unplaced.length) {
      console.log(`\n${c.yellow('unplaced')}  ${map.body.unplaced.join(', ')}`)
    }

    if (events.body.events.length) {
      console.log(`\n${c.dim('recent')}`)
      for (const e of events.body.events) {
        const arrow = e.from ? `${e.from} → ${e.to}` : `→ ${e.to}`
        console.log(`  ${relativeTime(e.at).padEnd(9)} ${e.service.padEnd(12)} ${c.dim(e.reason)} ${arrow}`)
      }
    }
  },
}

export const eventsCommand = {
  async run(_args: string[], flags: Flags) {
    const fleetId = await requireFleet(typeof flags.fleet === 'string' ? flags.fleet : undefined)
    const limit = typeof flags.limit === 'string' ? flags.limit : '30'
    const { body } = await request<{
      events: Array<{ at: string; service: string; reason: string; from: string | null; to: string | null; detail: any }>
    }>('GET', `/fleets/${fleetId}/events?limit=${limit}`)

    if (flags.json) return console.log(JSON.stringify(body.events, null, 2))
    if (!body.events.length) return console.log('no events yet')

    console.log(
      table(
        ['when', 'service', 'reason', 'from', 'to', 'score'],
        body.events.map((e) => [
          relativeTime(e.at),
          e.service,
          e.reason === 'failover' ? c.yellow(e.reason) : e.reason,
          e.from ?? c.dim('—'),
          e.to ?? c.dim('—'),
          typeof e.detail?.score === 'number' ? e.detail.score.toFixed(3) : c.dim('—'),
        ])
      )
    )
  },
}

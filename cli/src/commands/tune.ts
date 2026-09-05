import { request, requireFleet } from '../api.js'
import { c } from '../render.js'
import { glyph, rule } from '../ui.js'
import { asQuantity, tuneRam, MIN_OBSERVATION_HOURS, type Observed } from '../tune.js'
import type { Flags } from '../args.js'

type Service = Observed & { id: string }

/**
 * Reservations, checked against what the services actually used.
 *
 * It proposes and never applies. Every number here is the system inferring
 * something about a machine, and the lesson of every inference this project has
 * shipped is that one leaving its evidence needs a person between it and the
 * manifest — a review once invented a node from a compose service name, and
 * once replaced a `build:` with `image: nginx:alpine` and served the welcome
 * page over somebody's site. Both were caught by a guardrail. A person reading
 * a diff is the cheapest guardrail there is.
 */
export const tuneCommand = {
  async run(_args: string[], flags: Flags) {
    const fleetId = await requireFleet(typeof flags.fleet === 'string' ? flags.fleet : undefined)
    const { body } = await request<{ services: Service[] }>('GET', `/fleets/${fleetId}/services`)

    const advice = body.services.map((s) => tuneRam(s))

    if (flags.json) return console.log(JSON.stringify({ fleetId, advice }, null, 2))

    console.log(`\n${rule('tune · reservations against measured use')}`)

    const advised = advice.filter((a) => a.verdict === 'advise')
    const tight = advice.filter((a) => a.verdict === 'tight')
    const waiting = advice.filter((a) => a.verdict === 'too-soon' || a.verdict === 'no-data')

    for (const a of advice) {
      if (a.verdict === 'advise') {
        console.log(
          `${glyph.warn} ${c.bold(a.name.padEnd(18))} reserves ${asQuantity(a.from)}, peaks at ${a.peak}MB` +
            ` → ${c.bold(asQuantity(a.to))}`
        )
      } else if (a.verdict === 'tight') {
        console.log(
          `${glyph.warn} ${c.bold(a.name.padEnd(18))} peaks at ${a.peak}MB of ${asQuantity(a.requestRamMb)}` +
            ` — close to its limit, which is also where the kernel kills it`
        )
      } else if (a.verdict === 'fits') {
        console.log(`${glyph.ok} ${c.bold(a.name.padEnd(18))} peaks at ${a.peak}MB — about right`)
      } else if (a.verdict === 'too-soon') {
        console.log(
          `${glyph.info} ${c.dim(a.name.padEnd(18))} ${c.dim(`watched for ${a.hours}h; needs ${MIN_OBSERVATION_HOURS}h`)}`
        )
      } else {
        console.log(`${glyph.info} ${c.dim(a.name.padEnd(18))} ${c.dim('not measured yet')}`)
      }
    }

    if (advised.length) {
      console.log(`\n  ${c.dim('edit fleet.yaml, then')} fleet up`)
      for (const a of advised) {
        if (a.verdict !== 'advise') continue
        console.log(`  ${c.dim(`${a.name}:`)} resources: { ram: ${asQuantity(a.to)} }`)
      }
    }

    if (!advised.length && !tight.length) {
      console.log(
        `\n  ${c.dim(
          waiting.length === advice.length
            ? 'Nothing has been watched long enough to advise on yet.'
            : 'Every measured reservation is about right.'
        )}`
      )
    }
    console.log()
  },
}

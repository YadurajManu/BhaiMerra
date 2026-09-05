import { readFile, writeFile } from 'node:fs/promises'
import { parseDocument } from 'yaml'
import { CliError, EXIT, request, requireFleet } from '../api.js'
import { c } from '../render.js'
import { glyph, rule } from '../ui.js'
import { confirm } from '../prompt.js'
import { awaitRunning } from '../progress.js'
import type { Flags } from '../args.js'

/**
 * Diagnose, change one thing, deploy it, and put it back if that was worse.
 *
 * The loop can act here because it can undo. Every step is reversible: the
 * manifest edit is one field held in memory before it is written, and the
 * deploy that follows is a normal deploy, so a rollback is the same rollback
 * anybody else would run. Without that this would be a machine editing a
 * running system on the strength of a guess.
 *
 * It asks before applying. `--yes` skips the question for someone who wants it
 * unattended, and skips only the question -- the refusals below are not
 * confirmations and cannot be waived.
 */

type Fix = {
  service: string
  field: string
  value: string | number | boolean | null
  why: string
  applicable: boolean
  reason?: string
}

type Diagnosis =
  | { status: 'ok'; summary: string; findings: Array<{ claim: string; evidence: string }>; next: string[]; fix?: Fix }
  | { status: 'disabled'; reason: string }
  | { status: 'inconclusive'; reason: string }

type Service = { name: string; current: { status: string } | null }

/** How a manifest writes a value the model returned as a scalar. */
function shape(field: string, value: Fix['value']): unknown {
  // `health: /healthz` is the obvious way to say it and the manifest wants
  // `health: { path: /healthz }`. Same normalisation the server-side review
  // does, for the same reason: a difference in spelling should not cost a fix.
  if (field === 'health' && typeof value === 'string') return { path: value }
  return value
}

/** Whether a service is running right now, as the fleet sees it. */
async function statusOf(fleetId: string, name: string): Promise<string> {
  const { body } = await request<{ services: Service[] }>('GET', `/fleets/${fleetId}/services`)
  return body.services.find((s) => s.name === name)?.current?.status ?? 'not running'
}

export const fixCommand = {
  async run(args: string[], flags: Flags) {
    const service = args[0]
    if (!service) throw new CliError('usage: fleet fix <service> [--yes]', EXIT.usage)

    const fleetId = await requireFleet(typeof flags.fleet === 'string' ? flags.fleet : undefined)

    console.log(`\n${rule(`fix · ${service}`)}`)
    console.log(`${glyph.pending} looking…`)

    const { body: found } = await request<Diagnosis>('POST', `/fleets/${fleetId}/diagnose`, {
      body: { question: `Why is the "${service}" service not working as it should?` },
    })

    if (found.status !== 'ok') {
      throw new CliError(
        found.status === 'disabled' ? found.reason : `inconclusive — ${found.reason}`,
        EXIT.failure
      )
    }

    console.log(`\n${found.summary}\n`)
    for (const f of found.findings) {
      console.log(`  ${c.bold(f.claim)}`)
      console.log(`    ${c.dim(f.evidence)}`)
    }

    const fix = found.fix
    if (!fix) {
      // Most investigations do not end in one exact manifest change, and this
      // is not a failure. Saying what was found and stopping is the answer.
      console.log(`\n  ${c.dim('No single manifest change would fix this. What to do:')}`)
      for (const n of found.next) console.log(`  ${c.dim('›')} ${n}`)
      console.log()
      return
    }

    if (!fix.applicable) {
      // Reported in words, never performed. A person clicking through a prompt
      // is not a guardrail; not offering the button is.
      console.log(`\n${glyph.warn} ${c.bold('This one has to be done by hand')}`)
      console.log(`  ${fix.service}.${fix.field} → ${JSON.stringify(fix.value)}`)
      console.log(`  ${c.dim(fix.why)}`)
      console.log(`  ${c.dim(fix.reason ?? '')}`)
      console.log()
      return
    }

    console.log(`\n${glyph.info} ${c.bold('proposed')}  ${fix.service}.${fix.field} → ${JSON.stringify(fix.value)}`)
    console.log(`  ${c.dim(fix.why)}\n`)

    if (!flags.yes && !flags.y) {
      const ok = await confirm(`Apply this to fleet.yaml and redeploy ${fix.service}?`)
      if (!ok) return console.log(`  ${c.dim('left alone')}\n`)
    }

    // Read before writing, and keep the original in memory: this is what makes
    // the change reversible without a second file on disk.
    const path = 'fleet.yaml'
    const before = await readFile(path, 'utf8').catch(() => {
      throw new CliError(`No fleet.yaml here. Run this from the project directory.`, EXIT.usage)
    })

    const doc = parseDocument(before)
    if (!doc.hasIn(['services', fix.service])) {
      throw new CliError(`fleet.yaml has no service named "${fix.service}"`, EXIT.failure)
    }

    // Edited as a document, so the comments `fleet init` wrote survive. A
    // round trip through parse and re-serialise would take them out, and they
    // are the only explanation a generated manifest carries.
    if (fix.value === null) doc.deleteIn(['services', fix.service, fix.field])
    else doc.setIn(['services', fix.service, fix.field], shape(fix.field, fix.value))

    const wasRunning = (await statusOf(fleetId, fix.service)) === 'running'
    await writeFile(path, String(doc))
    console.log(`${glyph.ok} fleet.yaml updated`)

    const restore = async (why: string) => {
      await writeFile(path, before)
      console.log(`${glyph.warn} ${why} — fleet.yaml put back`)
      console.log(`  ${c.dim(`Deploy the previous manifest with: fleet up ${fix.service}`)}\n`)
    }

    console.log(`${glyph.pending} deploying…`)

    const { body: svc } = await request<{ services: Array<{ id: string; name: string }> }>(
      'GET',
      `/fleets/${fleetId}/services`
    )
    const target = svc.services.find((s) => s.name === fix.service)
    if (!target) {
      await restore(`"${fix.service}" is not in this fleet`)
      return
    }

    // Verification, and the reason the whole thing is defensible at all: a
    // change that did not help is undone rather than left behind.
    //
    // Followed to a conclusion rather than read once. The deploy request
    // returns when a node has been chosen, and the container starting is the
    // agent's job afterwards -- so reading the status here would find
    // "deploying" and call that success, which is a verification step that
    // verifies nothing.
    //
    // Judged against where it started. A service that was already down and is
    // still down has not been made worse by this edit, and putting the
    // manifest back would take away a change that may well be right while
    // leaving the real problem in place.
    try {
      await request('POST', `/services/${target.id}/deploy`, { body: {} })
      await awaitRunning(target, { timeoutMs: 240_000 })
    } catch (err) {
      if (wasRunning) {
        await restore(`${fix.service} was running before and did not come back: ${(err as Error).message}`)
        return
      }
      console.log(`${glyph.warn} still not running — ${(err as Error).message}`)
      console.log(`  ${c.dim('The edit was kept: it was already down, so this did not make it worse.')}`)
      console.log(`  ${c.dim(`undo it with: git checkout fleet.yaml && fleet up ${fix.service}`)}\n`)
      return
    }

    console.log(`${glyph.ok} ${fix.service} is running`)
    console.log(`\n  ${c.dim('check it settled:')} fleet deployments ${fix.service}`)
    console.log(`  ${c.dim('undo it:')} git checkout fleet.yaml && fleet up ${fix.service}\n`)
  },
}

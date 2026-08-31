/**
 * fleet secrets — the fleet credential store.
 *
 * The one rule this command exists to enforce: a secret value never appears in
 * `argv`. Arguments land in shell history, in `ps` output for every user on the
 * box, and in CI logs — so `fleet secrets set KEY hunter2` is deliberately not
 * a supported spelling. The value comes from a pipe or from a prompt with the
 * echo off, and nothing here ever prints one back.
 */
import { request, requireFleet, CliError, EXIT } from '../api.js'
import { c, table, relativeTime } from '../render.js'
import { glyph } from '../ui.js'
import { askSecret, canPrompt } from '../prompt.js'
import type { Flags } from '../args.js'

type SecretRow = {
  key: string
  scope: 'fleet' | 'service'
  service: string | null
  createdAt: string
  updatedAt: string
}

const KEY_PATTERN = /^[A-Z_][A-Z0-9_]{0,127}$/

/**
 * Read the value from a pipe when there is one, otherwise ask for it.
 *
 * The piped form is what a script or a password manager uses:
 *   pass show db/url | fleet secrets set DATABASE_URL
 *
 * Trailing newlines are stripped because every here-string and every `echo`
 * adds one, and a credential with an invisible newline on the end fails
 * authentication somewhere far away from here.
 */
async function readValue(key: string): Promise<string> {
  if (!process.stdin.isTTY) {
    const chunks: Buffer[] = []
    for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk))
    const piped = Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '')
    if (piped) return piped
  }

  if (!canPrompt()) {
    throw new CliError(
      `No value for ${key}. Pipe it in, or run this where there is a terminal to type into:\n` +
        `  echo -n "value" | fleet secrets set ${key}`,
      EXIT.usage
    )
  }
  return askSecret(`${key}`, { hint: 'the value is not echoed and is not stored in shell history' })
}

async function resolveServiceId(fleetId: string, name: string): Promise<{ id: string; name: string }> {
  const { body } = await request<{ services: Array<{ id: string; name: string }> }>(
    'GET',
    `/fleets/${fleetId}/services`
  )
  const match = body.services.find((s) => s.name === name || s.id === name)
  if (!match) {
    throw new CliError(
      `No service called "${name}". Known: ${body.services.map((s) => s.name).join(', ') || 'none'}`,
      EXIT.usage
    )
  }
  return match
}

export const secretsCommand = {
  async run(args: string[], flags: Flags) {
    const [sub, key] = args
    const service = typeof flags.service === 'string' ? flags.service : undefined

    /* ── list ──────────────────────────────────────────────────── */
    if (!sub || sub === 'ls' || sub === 'list') {
      const fleetId = await requireFleet(typeof flags.fleet === 'string' ? flags.fleet : undefined)
      const { body } = await request<{ secrets: SecretRow[] }>('GET', `/fleets/${fleetId}/secrets`)

      if (flags.json) return console.log(JSON.stringify(body.secrets, null, 2))

      if (!body.secrets.length) {
        console.log('No secrets in this fleet.')
        console.log(c.dim('  set one with `fleet secrets set DATABASE_URL`'))
        return
      }

      console.log(
        table(
          ['key', 'scope', 'updated'],
          body.secrets.map((s) => [
            s.key,
            s.scope === 'service' ? `${c.dim('service:')}${s.service ?? '?'}` : c.dim('fleet'),
            relativeTime(s.updatedAt),
          ])
        )
      )
      console.log(
        c.dim(`\n  ${body.secrets.length} stored. Values cannot be read back — only replaced.`)
      )
      return
    }

    /* ── set ───────────────────────────────────────────────────── */
    if (sub === 'set') {
      if (!key) throw new CliError('usage: fleet secrets set <KEY> [--service <name>]', EXIT.usage)
      if (!KEY_PATTERN.test(key)) {
        throw new CliError(
          `"${key}" is not a usable environment variable name.\n` +
            `  Use upper snake case: A-Z, 0-9 and _, not starting with a digit.`,
          EXIT.usage
        )
      }
      // A third positional is almost always someone typing the value inline.
      // Refuse it rather than accepting a credential into shell history.
      if (args[2]) {
        throw new CliError(
          'Do not pass the value as an argument — it would be written to your shell history.\n' +
            `  Pipe it:   echo -n "value" | fleet secrets set ${key}\n` +
            `  Or type it: fleet secrets set ${key}`,
          EXIT.usage
        )
      }

      const fleetId = await requireFleet(typeof flags.fleet === 'string' ? flags.fleet : undefined)
      const target = service ? await resolveServiceId(fleetId, service) : null
      const value = await readValue(key)

      const path = target
        ? `/services/${target.id}/secrets/${encodeURIComponent(key)}`
        : `/fleets/${fleetId}/secrets/${encodeURIComponent(key)}`

      const { body } = await request<{ created: boolean }>('PUT', path, { body: { value } })

      const where = target ? ` for ${c.bold(target.name)}` : ''
      console.log(`${glyph.ok} ${c.green(body.created ? 'stored' : 'replaced')}  ${c.bold(key)}${where}`)
      console.log(c.dim('  takes effect on the next deploy of any service that references it'))
      return
    }

    /* ── rm ────────────────────────────────────────────────────── */
    if (sub === 'rm' || sub === 'remove' || sub === 'delete') {
      if (!key) throw new CliError('usage: fleet secrets rm <KEY> [--service <name>]', EXIT.usage)

      const fleetId = await requireFleet(typeof flags.fleet === 'string' ? flags.fleet : undefined)
      const target = service ? await resolveServiceId(fleetId, service) : null

      const path = target
        ? `/services/${target.id}/secrets/${encodeURIComponent(key)}`
        : `/fleets/${fleetId}/secrets/${encodeURIComponent(key)}`

      await request('DELETE', path)
      const where = target ? ` override for ${c.bold(target.name)}` : ''
      console.log(`${glyph.ok} ${c.yellow('removed')}  ${c.bold(key)}${where}`)
      console.log(
        c.dim('  services already running keep the value they started with until redeployed')
      )
      return
    }

    throw new CliError(
      'usage: fleet secrets [ls]\n' +
        '       fleet secrets set <KEY> [--service <name>]\n' +
        '       fleet secrets rm  <KEY> [--service <name>]',
      EXIT.usage
    )
  },
}

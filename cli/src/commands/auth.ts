import { createInterface } from 'node:readline/promises'
import { request, CliError, EXIT } from '../api.js'
import { loadProfile, saveProfile, configLocation } from '../config.js'
import { c, keyValues } from '../render.js'
import { banner } from '../mark.js'
import { glyph, rule, task } from '../ui.js'
import type { Flags } from '../args.js'

async function prompt(question: string, silent = false): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  if (!silent) {
    const answer = await rl.question(question)
    rl.close()
    return answer.trim()
  }
  // Passwords must not land in the terminal scrollback or a screen recording.
  const stdout = process.stdout as NodeJS.WriteStream & { _writeToOutput?: (s: string) => void }
  process.stdout.write(question)
  const rlAny = rl as unknown as { output: NodeJS.WriteStream; _writeToOutput: (s: string) => void }
  rlAny._writeToOutput = () => {}
  const answer = await rl.question('')
  rl.close()
  process.stdout.write('\n')
  void stdout
  return answer.trim()
}

async function requiredPrompt(label: string, opts: { silent?: boolean; hint?: string } = {}): Promise<string> {
  if (opts.hint) console.log(c.dim(`  ${opts.hint}`))
  const value = await prompt(`  ${c.dim(label.padEnd(18))}`, opts.silent)
  if (!value) throw new CliError(`${label.trim()} is required.`, EXIT.usage)
  return value
}

function validApi(value: string): string {
  try {
    const url = new URL(value)
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('scheme')
    return url.toString().replace(/\/+$/, '')
  } catch {
    throw new CliError('Control plane URL must begin with http:// or https://', EXIT.usage)
  }
}

export const authCommand = {
  async run(args: string[], flags: Flags) {
    const [sub] = args
    const profile = await loadProfile()
    if (typeof flags.api === 'string') profile.api = flags.api

    switch (sub) {
      case 'login': {
        const interactive = !flags.email && !flags.password
        if (interactive) {
          console.log(banner('secure control-plane sign in'))
          console.log(`\n${rule('sign in')}`)
        }

        if (!profile.api) {
          profile.api = validApi(
            await requiredPrompt('control plane URL', {
              hint: 'Example: https://fleetapi.yourdomain.com',
            })
          )
        }

        if (interactive) {
          console.log(`${c.dim('  control plane      ')}${c.cyan(profile.api)}`)
          console.log()
        }

        const email =
          (typeof flags.email === 'string' ? flags.email : '') ||
          (await requiredPrompt('email'))
        const password =
          (typeof flags.password === 'string' ? flags.password : '') ||
          (await requiredPrompt('password', { silent: true, hint: 'Password is hidden while you type.' }))

        const body = await task(
          'verifying credentials',
          async () =>
            (
              await request<{
                accessToken: string
                refreshToken: string
                user: { email: string }
              }>('POST', '/auth/login', { body: { email, password }, auth: false, profile })
            ).body,
          { hints: ['the control plane never stores your password in this CLI'] }
        )

        await saveProfile({
          ...profile,
          accessToken: body.accessToken,
          refreshToken: body.refreshToken,
        })
        console.log(`\n${glyph.ok} ${c.signal('signed in')}  ${body.user.email}`)
        console.log(c.dim(`  profile saved to ${configLocation()}`))
        console.log(c.dim('  next: fleet status'))
        return
      }

      case 'logout': {
        await saveProfile({ api: profile.api })
        console.log('signed out')
        return
      }

      case 'whoami': {
        const { body } = await request<{
          user: { email: string; id: string }
          orgs: Array<{ orgName: string; role: string; plan: string }>
        }>('GET', '/auth/me', { profile })

        if (flags.json) return console.log(JSON.stringify(body, null, 2))
        console.log(
          keyValues([
            ['email', body.user.email],
            ['control plane', profile.api],
            ...body.orgs.map((o): [string, string] => [o.orgName, `${o.role} · ${o.plan}`]),
          ])
        )
        return
      }

      default:
        throw new CliError('usage: fleet auth login|logout|whoami', EXIT.usage)
    }
  },
}

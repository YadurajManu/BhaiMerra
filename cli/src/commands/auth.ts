import { createInterface } from 'node:readline/promises'
import { request, CliError, EXIT } from '../api.js'
import { loadProfile, saveProfile, configLocation } from '../config.js'
import { c, keyValues } from '../render.js'
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

export const authCommand = {
  async run(args: string[], flags: Flags) {
    const [sub] = args
    const profile = await loadProfile()
    if (typeof flags.api === 'string') profile.api = flags.api

    switch (sub) {
      case 'login': {
        const email = (typeof flags.email === 'string' ? flags.email : '') || (await prompt('email: '))
        const password =
          (typeof flags.password === 'string' ? flags.password : '') ||
          (await prompt('password: ', true))

        const { body } = await request<{
          accessToken: string
          refreshToken: string
          user: { email: string }
        }>('POST', '/auth/login', { body: { email, password }, auth: false, profile })

        await saveProfile({
          ...profile,
          accessToken: body.accessToken,
          refreshToken: body.refreshToken,
        })
        console.log(`${c.green('signed in')} as ${body.user.email}`)
        console.log(c.dim(`profile saved to ${configLocation()}`))
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

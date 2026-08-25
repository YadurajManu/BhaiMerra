import { createInterface } from 'node:readline/promises'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { exec } from 'node:child_process'
import { promisify } from 'node:util'
import { request, CliError, EXIT } from '../api.js'
import { loadProfile, saveProfile, configLocation, type Profile } from '../config.js'
import { c, keyValues } from '../render.js'
import { banner } from '../mark.js'
import { glyph, rule, task, spinner } from '../ui.js'
import type { Flags } from '../args.js'

const execAsync = promisify(exec)

async function openBrowserUrl(url: string): Promise<void> {
  const platform = process.platform
  let cmd = ''
  if (platform === 'darwin') cmd = `open "${url}"`
  else if (platform === 'win32') cmd = `start "" "${url}"`
  else cmd = `xdg-open "${url}"`
  try {
    await execAsync(cmd)
  } catch {
    // Ignore browser opener errors; URL is printed on screen
  }
}

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

function getWebUrl(api: string): string {
  if (api.includes('fleetapi.plastikworld.xyz')) return 'https://fleet.plastikworld.xyz'
  if (api.includes('localhost:8080') || api.includes('127.0.0.1:8080')) return 'http://localhost:5173'
  return api.replace(/fleetapi\./, 'fleet.')
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

type AuthResult = {
  accessToken: string
  refreshToken: string
  user: { email: string }
}

async function browserAuth(profile: Profile): Promise<AuthResult> {
  let localServer: Server | undefined
  let localPort = 0

  // 1. Create a local HTTP server on a random free port to receive redirect callback
  const tokenPromise = new Promise<AuthResult>((resolve) => {
    localServer = createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${localPort}`)
      if (url.pathname === '/callback') {
        const accessToken = url.searchParams.get('accessToken')
        const refreshToken = url.searchParams.get('refreshToken')
        const email = url.searchParams.get('email') ?? 'authenticated user'

        if (accessToken && refreshToken) {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
          res.end(`
            <!text/html>
            <html>
              <head><title>Fleet OS — Authenticated</title></head>
              <body style="font-family: system-ui, sans-serif; background: #0a0c10; color: #fff; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0;">
                <div style="text-align: center; padding: 2rem; background: #161b22; border: 1px solid #30363d; border-radius: 8px;">
                  <h1 style="color: #3fe08b; margin-bottom: 0.5rem;">✔ Authenticated!</h1>
                  <p style="color: #8b949e;">Your CLI session is signed in. You can close this tab and return to your terminal.</p>
                </div>
              </body>
            </html>
          `)
          resolve({ accessToken, refreshToken, user: { email } })
          return
        }
      }
      res.writeHead(400, { 'Content-Type': 'text/plain' })
      res.end('Invalid authorization callback')
    })

    localServer.listen(0, '127.0.0.1', () => {
      localPort = (localServer!.address() as AddressInfo).port
    })
  })

  // Wait briefly for server to bind
  let attempts = 0
  while (!localPort && attempts++ < 20) await sleep(50)

  // 2. Request a CLI auth session code from control plane
  const { body: session } = await request<{ code: string }>('POST', '/auth/cli-session', {
    body: { port: localPort },
    auth: false,
    profile,
  })

  const webBase = getWebUrl(profile.api)
  const authUrl = `${webBase}/cli-auth?code=${session.code}&port=${localPort}&api=${encodeURIComponent(profile.api)}`

  // 3. Prompt user to press ENTER
  if (process.stdin.isTTY) {
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    console.log(c.dim('  Press ENTER to open your browser to log in, or Ctrl+C to cancel...'))
    await rl.question('')
    rl.close()
  }

  console.log(`${glyph.info} Opening browser to ${c.cyan(authUrl)}`)
  await openBrowserUrl(authUrl)

  // 4. Concurrently poll the control plane in case local callback port isn't reachable (e.g. SSH / remote)
  const pollPromise = (async (): Promise<AuthResult> => {
    const deadline = Date.now() + 600_000 // 10 min
    while (Date.now() < deadline) {
      await sleep(2000)
      try {
        const { body } = await request<{
          status: string
          accessToken?: string
          refreshToken?: string
          user?: { email: string }
        }>('GET', `/auth/cli-session/${session.code}/poll`, { auth: false, profile })

        if (body.status === 'approved' && body.accessToken && body.refreshToken) {
          return {
            accessToken: body.accessToken,
            refreshToken: body.refreshToken,
            user: body.user ?? { email: 'authenticated user' },
          }
        }
      } catch {
        // Continue polling until deadline or callback
      }
    }
    throw new CliError('Login session timed out waiting for browser authentication.', EXIT.usage)
  })()

  const s = spinner('waiting for browser authentication...')
  s.hints(['complete sign in in your browser window', 'press Ctrl+C to abort'])

  try {
    const result = await Promise.race([tokenPromise, pollPromise])
    s.succeed()
    return result
  } catch (err) {
    s.fail()
    throw err
  } finally {
    localServer?.close()
  }
}

export const authCommand = {
  async run(args: string[], flags: Flags) {
    const [sub] = args
    const profile = await loadProfile()
    if (typeof flags.api === 'string') profile.api = flags.api

    switch (sub) {
      case 'login': {
        const hasDirectCreds = Boolean(flags.email || flags.password || flags.terminal)
        
        console.log(banner('secure control-plane sign in'))
        console.log(`\n${rule('sign in')}`)

        if (!profile.api) {
          profile.api = validApi(
            await requiredPrompt('control plane URL', {
              hint: 'Example: https://fleetapi.yourdomain.com',
            })
          )
        }

        console.log(`${c.dim('  control plane      ')}${c.cyan(profile.api)}\n`)

        let authData: AuthResult

        // Direct credentials or terminal mode flag
        if (hasDirectCreds) {
          const email =
            (typeof flags.email === 'string' ? flags.email : '') ||
            (await requiredPrompt('email'))
          const password =
            (typeof flags.password === 'string' ? flags.password : '') ||
            (await requiredPrompt('password', { silent: true, hint: 'Password is hidden while you type.' }))

          authData = await task(
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
        } else {
          // Default: Modern Browser Web OAuth Login
          authData = await browserAuth(profile)
        }

        await saveProfile({
          ...profile,
          accessToken: authData.accessToken,
          refreshToken: authData.refreshToken,
        })
        console.log(`\n${glyph.ok} ${c.signal('signed in')}  ${authData.user.email}`)
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

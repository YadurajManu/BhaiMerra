import { loadProfile, saveProfile, type Profile } from './config.js'

export class CliError extends Error {
  constructor(message: string, readonly exitCode = 1, readonly detail?: unknown) {
    super(message)
  }
}

/** Exit codes are a contract; scripts branch on them (docs/cli reference). */
export const EXIT = {
  ok: 0,
  failure: 1,
  usage: 2,
  noEligibleNode: 3,
  healthCheckFailed: 4,
} as const

export type ApiResult<T> = { status: number; body: T }

export async function request<T = any>(
  method: string,
  path: string,
  opts: { body?: unknown; auth?: boolean; profile?: Profile } = {}
): Promise<ApiResult<T>> {
  const profile = opts.profile ?? (await loadProfile())
  if (opts.auth !== false && !profile.accessToken) {
    throw new CliError('Not signed in. Run `fleet auth login` first.', EXIT.usage)
  }

  const send = async (token?: string) =>
    fetch(profile.api.replace(/\/+$/, '') + path, {
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(opts.body ? { 'content-type': 'application/json' } : {}),
      },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      signal: AbortSignal.timeout(20 * 60_000),
    })

  let res: Response
  try {
    res = await send(profile.accessToken)
  } catch (err) {
    throw new CliError(
      `Could not reach ${profile.api}. Is the control plane running?\n  ${String(err)}`,
      EXIT.failure
    )
  }

  // Access tokens are short-lived; refresh once and retry rather than making
  // the user log in again mid-command.
  if (res.status === 401 && profile.refreshToken) {
    const refreshed = await fetch(profile.api.replace(/\/+$/, '') + '/auth/refresh', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken: profile.refreshToken }),
    })
    if (refreshed.ok) {
      const tokens = (await refreshed.json()) as { accessToken: string; refreshToken: string }
      await saveProfile({ ...profile, ...tokens })
      res = await send(tokens.accessToken)
    }
  }

  const text = await res.text()
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    body = text
  }

  if (res.status >= 400) {
    const err = (body as { error?: { code?: string; message?: string; detail?: unknown } }).error
    throw new CliError(
      err?.message ?? `Request failed (${res.status})`,
      err?.code === 'no_eligible_node' ? EXIT.noEligibleNode : EXIT.failure,
      err?.detail
    )
  }

  return { status: res.status, body: body as T }
}

export async function requireFleet(explicit?: string): Promise<string> {
  if (explicit) return explicit
  const profile = await loadProfile()
  if (profile.fleetId) return profile.fleetId

  const { body } = await request<{ fleets: Array<{ id: string; name: string }> }>('GET', '/fleets')
  if (body.fleets.length === 1) return body.fleets[0]!.id
  if (!body.fleets.length) throw new CliError('You have no fleets yet.', EXIT.usage)
  throw new CliError(
    `You are in several fleets. Pass --fleet <id> or run \`fleet use <name>\`:\n` +
      body.fleets.map((f) => `  ${f.name}  ${f.id}`).join('\n'),
    EXIT.usage
  )
}

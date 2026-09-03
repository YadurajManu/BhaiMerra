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
  opts: {
    body?: unknown
    /** Sent as-is with its own content type. Used for the build context tarball. */
    raw?: { data: Uint8Array; contentType: string }
    auth?: boolean
    profile?: Profile
  } = {}
): Promise<ApiResult<T>> {
  const profile = opts.profile ?? (await loadProfile())
  if (!profile.api) {
    throw new CliError(
      'No control plane URL is configured. Run `fleet auth login --api https://your-api-host` or set FLEET_API.',
      EXIT.usage
    )
  }
  if (opts.auth !== false && !profile.accessToken) {
    throw new CliError('Not signed in. Run `fleet auth login` first.', EXIT.usage)
  }

  const send = async (token?: string) =>
    fetch(profile.api.replace(/\/+$/, '') + path, {
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(opts.raw
          ? { 'content-type': opts.raw.contentType }
          : opts.body
            ? { 'content-type': 'application/json' }
            : {}),
      },
      body: opts.raw ? opts.raw.data : opts.body ? JSON.stringify(opts.body) : undefined,
      signal: AbortSignal.timeout(20 * 60_000),
    })

  let res: Response
  try {
    res = await send(opts.auth === false ? undefined : profile.accessToken)
  } catch (err) {
    throw new CliError(
      `Could not reach ${profile.api}. Is the control plane running?\n  ${String(err)}`,
      EXIT.failure
    )
  }

  // Access tokens are short-lived; refresh once and retry rather than making
  // the user log in again mid-command.
  if (res.status === 401) {
    if (profile.refreshToken) {
      try {
        const refreshed = await fetch(profile.api.replace(/\/+$/, '') + '/auth/refresh', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ refreshToken: profile.refreshToken }),
          signal: AbortSignal.timeout(15_000),
        })
        if (refreshed.ok) {
          const tokens = (await refreshed.json()) as { accessToken: string; refreshToken: string }
          await saveProfile({ ...profile, ...tokens })
          res = await send(tokens.accessToken)
        }
      } catch {
        // Fall through to a deliberate, actionable session-expired message.
        // A network error while refreshing must not turn into a misleading
        // "invalid token" response from the original request.
      }
    }
    if (res.status === 401) {
      throw new CliError(
        'Your Fleet session has expired. Run `fleet auth login` to sign in again.',
        EXIT.usage
      )
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

  // A cached id is a hint, not a fact. It survives the fleet being deleted, the
  // control plane being rebuilt, and signing in as somebody else — and the
  // failure was a bare "Fleet not found" on every command, which names neither
  // the cache nor the way out. Verify it, and fall through when it is stale.
  if (profile.fleetId) {
    try {
      await request('GET', `/fleets/${profile.fleetId}`)
      return profile.fleetId
    } catch (err) {
      if (!(err instanceof CliError) || err.exitCode !== EXIT.failure) throw err
      await saveProfile({ ...profile, fleetId: undefined, fleetName: undefined })
    }
  }

  const { body } = await request<{ fleets: Array<{ id: string; name: string }> }>('GET', '/fleets')
  if (body.fleets.length === 1) {
    // Remember it, so the next command does not pay for this lookup again.
    await saveProfile({ ...profile, fleetId: body.fleets[0]!.id, fleetName: body.fleets[0]!.name })
    return body.fleets[0]!.id
  }
  if (!body.fleets.length) {
    throw new CliError(
      'This account owns no fleets on ' + (profile.api ?? 'this control plane') + '.\n' +
        '  If you expected one, you may be signed in as the wrong account — check with `fleet auth whoami`,\n' +
        '  or create a fleet in the dashboard and run `fleet use <name>`.',
      EXIT.usage
    )
  }
  throw new CliError(
    `You are in several fleets. Pass --fleet <id> or run \`fleet use <name>\`:\n` +
      body.fleets.map((f) => `  ${f.name}  ${f.id}`).join('\n'),
    EXIT.usage
  )
}

import { randomBytes } from 'node:crypto'
import { ApiError } from '../api/errors.js'
import type { GitHubConfig } from './app.js'
import type { AppContext } from '../api/context.js'

/**
 * The bind between a GitHub installation and a Fleet org.
 *
 * GitHub's install flow leaves the browser at the App's setup URL carrying an
 * `installation_id` and whatever `state` we sent it away with. That `state` is
 * the only thing tying the new installation back to the person who asked for
 * it, so it is server-generated, single-use, and short-lived — the same
 * treatment an OAuth state parameter gets, and for the same reason: without it
 * anyone who learns an installation id could POST it and claim the account.
 */

const PREFIX = 'ghinstall:'
const TTL_SECONDS = 600

export type InstallIntent = {
  orgId: string
  fleetId: string
  userId: string
}

/** Mint a nonce for one install attempt. */
export async function beginInstall(ctx: AppContext, intent: InstallIntent): Promise<string> {
  const state = randomBytes(32).toString('base64url')
  await ctx.redis.set(PREFIX + state, JSON.stringify(intent), 'EX', TTL_SECONDS)
  return state
}

/**
 * Redeem a nonce. Deleted on read: a replayed callback must not be able to
 * re-claim an installation that has since been released.
 */
export async function redeemInstall(ctx: AppContext, state: string): Promise<InstallIntent | null> {
  if (!state) return null
  const key = PREFIX + state
  const raw = await ctx.redis.get(key)
  if (!raw) return null
  await ctx.redis.del(key)
  try {
    return JSON.parse(raw) as InstallIntent
  } catch {
    return null
  }
}

/**
 * Where to send someone to install the App.
 *
 * GitHub reflects `state` back to the App's configured setup URL. There is no
 * per-request redirect_uri to set here — the callback address lives in the
 * App's own settings, which is what makes it trustworthy.
 */
export function installUrl(config: GitHubConfig, state: string): string {
  if (!config.slug) {
    throw new ApiError(
      501,
      'github_slug_missing',
      'This control plane knows the GitHub App by id but not by name, so it cannot link to the ' +
        'install page. Set GITHUB_APP_SLUG to the value in https://github.com/apps/<slug>.'
    )
  }
  const slug = encodeURIComponent(config.slug)
  return `https://github.com/apps/${slug}/installations/new?state=${encodeURIComponent(state)}`
}

/**
 * Where to drop the browser once the claim succeeds or fails.
 *
 * Restricted to the configured dashboard origin. This value ends up in a
 * `Location` header on an endpoint GitHub redirects into, so taking it from
 * the request would be an open redirect on an unauthenticated route.
 */
export function dashboardReturn(
  config: { PUBLIC_DASHBOARD_URL?: string },
  outcome: 'connected' | 'failed',
  detail?: string
): string {
  const base = (config.PUBLIC_DASHBOARD_URL ?? '').replace(/\/+$/, '')
  const query = `github=${outcome}${detail ? `&reason=${encodeURIComponent(detail)}` : ''}`
  return `${base}/settings?${query}`
}

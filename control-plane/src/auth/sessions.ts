import { createHash } from 'node:crypto'
import { and, eq, sql } from 'drizzle-orm'
import { authSessions } from '../db/schema.js'
import type { AppContext } from '../api/context.js'

/**
 * Recognising a sign-in as new.
 *
 * The hard part is not detection, it is restraint. An alert that fires on every
 * login is one people learn to delete unread, which is worse than sending
 * nothing at all — it trains the recipient to ignore the one that matters. So
 * the fingerprint is deliberately coarse and the trigger is deliberately
 * narrow.
 */

export type LoginContext = {
  ip: string | null
  userAgent: string | null
  country: string | null
}

export type Device = { browser: string; os: string }

/**
 * Parse only the two facets that stay still: browser family and OS family.
 *
 * Versions are excluded on purpose. Chrome ships a major version every four
 * weeks and phones update themselves overnight, so including versions would
 * make a routine update indistinguishable from an intrusion.
 */
export function parseDevice(ua: string | null): Device {
  const s = ua ?? ''
  const browser =
    /\bEdg\//.test(s) ? 'Edge'
    : /\bOPR\/|\bOpera/.test(s) ? 'Opera'
    : /\bFirefox\//.test(s) ? 'Firefox'
    : /\bChrome\//.test(s) ? 'Chrome'
    : /\bSafari\//.test(s) && /\bVersion\//.test(s) ? 'Safari'
    : /curl\//i.test(s) ? 'curl'
    : /fleet-cli/i.test(s) ? 'Fleet CLI'
    : s.trim() === '' ? 'Unknown client'
    : 'Other'

  // Order matters and is not obvious. An iPhone reports "like Mac OS X" and
  // Android reports "Linux", so the specific mobile platforms have to be
  // tested before the desktop ones they impersonate. Getting this backwards
  // files an iPhone as macOS — and since both report Safari, a phone sign-in
  // would then be indistinguishable from the owner's laptop.
  const os =
    /\bWindows NT/.test(s) ? 'Windows'
    : /\biPhone|\biPad|\biPod/.test(s) ? 'iOS'
    : /\bAndroid/.test(s) ? 'Android'
    : /\bMac OS X|\bMacintosh/.test(s) ? 'macOS'
    : /\bCrOS/.test(s) ? 'ChromeOS'
    : /\bLinux|\bX11/.test(s) ? 'Linux'
    : 'Unknown OS'

  return { browser, os }
}

export const deviceHash = (d: Device) =>
  createHash('sha256').update(`${d.browser}|${d.os}`).digest('hex').slice(0, 32)

/** Human label for the email. "Chrome on macOS" is what a person recognises. */
export const describeDevice = (d: Device) => `${d.browser} on ${d.os}`

/**
 * Pull the client's address and country from the edge.
 *
 * Behind Cloudflare Tunnel the real address arrives as cf-connecting-ip and the
 * country as cf-ipcountry; `trustProxy` makes req.ip correct for the
 * x-forwarded-for case. All three are absent on a direct connection, which is
 * why every field here is nullable rather than defaulted to something wrong.
 */
export function loginContextFrom(headers: Record<string, unknown>, reqIp?: string): LoginContext {
  const one = (v: unknown): string | null => {
    const s = Array.isArray(v) ? v[0] : v
    return typeof s === 'string' && s.trim() !== '' ? s.trim() : null
  }
  const country = one(headers['cf-ipcountry'])
  return {
    ip: one(headers['cf-connecting-ip']) ?? reqIp ?? null,
    userAgent: one(headers['user-agent']),
    // Cloudflare uses XX for "could not determine" and T1 for Tor.
    country: country && country !== 'XX' ? country : null,
  }
}

export type SignInVerdict = {
  /** True when the account owner should be told. */
  isNew: boolean
  /** Why, for the email and the logs. */
  reason: 'first_device' | 'new_country' | 'known'
  device: Device
  previousCountries: string[]
}

/**
 * Record a sign-in and decide whether it deserves an email.
 *
 * Two triggers, both chosen because they survive normal life:
 *
 *   - a device family never seen on this account before;
 *   - a country never seen before, even on a known device.
 *
 * A new IP inside a known country is not a trigger. Mobile networks rotate
 * addresses constantly — this project's own operator changed IP three times in
 * an afternoon — and alerting on that is pure noise.
 */
export async function recordSignIn(
  ctx: AppContext,
  userId: string,
  login: LoginContext
): Promise<SignInVerdict> {
  const device = parseDevice(login.userAgent)
  const hash = deviceHash(device)

  const rows = await ctx.db
    .select({
      deviceHash: authSessions.deviceHash,
      country: authSessions.country,
    })
    .from(authSessions)
    .where(eq(authSessions.userId, userId))

  const isFirstEver = rows.length === 0
  const knownDevice = rows.some((r) => r.deviceHash === hash)
  const previousCountries = [...new Set(rows.map((r) => r.country).filter((c): c is string => !!c))]
  const newCountry =
    Boolean(login.country) && previousCountries.length > 0 && !previousCountries.includes(login.country!)

  await ctx.db
    .insert(authSessions)
    .values({
      userId,
      deviceHash: hash,
      userAgent: login.userAgent,
      ip: login.ip,
      country: login.country,
    })
    .onConflictDoUpdate({
      target: [authSessions.userId, authSessions.deviceHash],
      set: {
        lastSeen: new Date(),
        ip: login.ip,
        country: login.country,
        loginCount: sql`${authSessions.loginCount} + 1`,
      },
    })

  // The very first sign-in on a brand new account is not a security event —
  // it is the person who just created it, and mailing them about it is noise
  // on top of the verification email they already have.
  if (isFirstEver) return { isNew: false, reason: 'first_device', device, previousCountries }

  if (!knownDevice) return { isNew: true, reason: 'first_device', device, previousCountries }
  if (newCountry) return { isNew: true, reason: 'new_country', device, previousCountries }

  return { isNew: false, reason: 'known', device, previousCountries }
}

/** Devices remembered for an account, newest first. Powers a future settings screen. */
export async function listDevices(ctx: AppContext, userId: string) {
  return ctx.db
    .select()
    .from(authSessions)
    .where(eq(authSessions.userId, userId))
    .orderBy(sql`${authSessions.lastSeen} desc`)
}

/** Forget a remembered device, so the next sign-in from it alerts again. */
export async function forgetDevice(ctx: AppContext, userId: string, hash: string) {
  const gone = await ctx.db
    .delete(authSessions)
    .where(and(eq(authSessions.userId, userId), eq(authSessions.deviceHash, hash)))
    .returning({ id: authSessions.id })
  return gone.length > 0
}

/**
 * The fleet secret store (FR-13, docs/fleet-yaml-spec.md).
 *
 * Values are sealed with the envelope encryption in lib/crypto.ts and only ever
 * come back out in one place: the desired state handed to the agent that is
 * going to run the container. Nothing else in this codebase should call
 * `openSecret` — if a second caller appears, that is the moment to ask whether
 * a secret is leaking into a response, a log, or an audit row.
 */
import { and, eq, inArray, isNull, sql } from 'drizzle-orm'
import { secrets } from '../db/schema.js'
import { sealSecret, openSecret, type SealedSecret } from '../lib/crypto.js'
import { ApiError } from '../api/errors.js'
import type { AppContext } from '../api/context.js'

/**
 * A secret becomes an environment variable, so it has to be a legal one. POSIX
 * says upper snake case, and a key like `my-key` would be silently unreadable
 * from most languages rather than failing loudly.
 */
export const SECRET_KEY_PATTERN = /^[A-Z_][A-Z0-9_]{0,127}$/

export type SecretScope = {
  fleetId: string
  /** null or omitted stores the value fleet-wide. */
  serviceId?: string | null
}

/** Everything about a secret except the one part that matters. */
export type SecretSummary = {
  key: string
  scope: 'fleet' | 'service'
  serviceId: string | null
  createdAt: Date
  updatedAt: Date
}

export function assertValidKey(key: string): void {
  if (!SECRET_KEY_PATTERN.test(key)) {
    throw ApiError.unprocessable(
      'invalid_secret_key',
      `"${key}" is not a usable environment variable name. Use upper snake case: A-Z, 0-9 and _, not starting with a digit.`
    )
  }
}

/**
 * Store a value, replacing any existing one at the same scope.
 *
 * Read-then-write inside a transaction rather than an upsert: the uniqueness
 * rule is split across two partial indexes, and spelling that out as a conflict
 * target is harder to read than the two statements it replaces.
 */
export async function setSecret(
  ctx: AppContext,
  scope: SecretScope,
  key: string,
  value: string
): Promise<{ created: boolean }> {
  assertValidKey(key)
  const sealed = sealSecret(value, ctx.config.SECRETS_MASTER_KEY)
  const serviceId = scope.serviceId ?? null

  return ctx.db.transaction(async (tx) => {
    const [existing] = await tx
      .select({ id: secrets.id })
      .from(secrets)
      .where(
        and(
          eq(secrets.fleetId, scope.fleetId),
          eq(secrets.key, key),
          serviceId ? eq(secrets.serviceId, serviceId) : isNull(secrets.serviceId)
        )
      )
      .limit(1)

    if (existing) {
      await tx
        .update(secrets)
        .set({ encryptedValue: sealed, updatedAt: new Date() })
        .where(eq(secrets.id, existing.id))
      return { created: false }
    }

    await tx.insert(secrets).values({
      fleetId: scope.fleetId,
      serviceId,
      key,
      encryptedValue: sealed,
    })
    return { created: true }
  })
}

/** Names and timestamps. There is deliberately no function that returns values. */
export async function listSecrets(ctx: AppContext, fleetId: string): Promise<SecretSummary[]> {
  const rows = await ctx.db
    .select({
      key: secrets.key,
      serviceId: secrets.serviceId,
      createdAt: secrets.createdAt,
      updatedAt: secrets.updatedAt,
    })
    .from(secrets)
    .where(eq(secrets.fleetId, fleetId))
    .orderBy(secrets.key)

  return rows.map((r) => ({
    key: r.key,
    scope: r.serviceId ? ('service' as const) : ('fleet' as const),
    serviceId: r.serviceId,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  }))
}

export async function deleteSecret(
  ctx: AppContext,
  scope: SecretScope,
  key: string
): Promise<boolean> {
  const serviceId = scope.serviceId ?? null
  const removed = await ctx.db
    .delete(secrets)
    .where(
      and(
        eq(secrets.fleetId, scope.fleetId),
        eq(secrets.key, key),
        serviceId ? eq(secrets.serviceId, serviceId) : isNull(secrets.serviceId)
      )
    )
    .returning({ id: secrets.id })
  return removed.length > 0
}

export type Resolution = {
  /** Decrypted, ready to become environment variables. */
  values: Record<string, string>
  /** Names the service asked for that nothing in the store answers. */
  missing: string[]
}

/**
 * Resolve the names a service declared into values.
 *
 * A service-scoped row wins over the fleet-wide one for the same key, so a
 * single service can be given a different credential without disturbing the
 * rest of the fleet.
 *
 * Missing names are returned rather than thrown, because the two callers want
 * different things: the deploy path turns them into a 422 before it writes a
 * deployment row, and the desired-state path omits them so an already-running
 * container is not torn down by a secret someone deleted.
 */
export async function resolveSecrets(
  ctx: AppContext,
  fleetId: string,
  serviceId: string,
  keys: readonly string[]
): Promise<Resolution> {
  if (!keys.length) return { values: {}, missing: [] }

  const rows = await ctx.db
    .select({
      key: secrets.key,
      serviceId: secrets.serviceId,
      encryptedValue: secrets.encryptedValue,
    })
    .from(secrets)
    .where(
      and(
        eq(secrets.fleetId, fleetId),
        inArray(secrets.key, [...keys]),
        sql`(${secrets.serviceId} is null or ${secrets.serviceId} = ${serviceId})`
      )
    )

  // Fleet-wide first, then let any service override write over it.
  const chosen = new Map<string, Record<string, string>>()
  for (const row of rows) {
    if (row.serviceId === null && !chosen.has(row.key)) chosen.set(row.key, row.encryptedValue)
  }
  for (const row of rows) {
    if (row.serviceId !== null) chosen.set(row.key, row.encryptedValue)
  }

  const values: Record<string, string> = {}
  const missing: string[] = []

  for (const key of keys) {
    const sealed = chosen.get(key)
    if (!sealed) {
      missing.push(key)
      continue
    }
    try {
      values[key] = openSecret(sealed as unknown as SealedSecret, ctx.config.SECRETS_MASTER_KEY)
    } catch {
      // A value that will not decrypt means the master key has changed since it
      // was sealed. Reporting it as missing is honest and keeps the message on
      // one path; the error must never carry ciphertext.
      missing.push(key)
    }
  }

  return { values, missing }
}

/**
 * The full environment for a service: plain manifest values first, then
 * secrets, so a secret always wins over a same-named plain value rather than
 * being silently shadowed by one.
 */
export async function buildEnv(
  ctx: AppContext,
  fleetId: string,
  service: { id: string; env: Record<string, string>; secretRefs: string[] }
): Promise<{ env: Record<string, string>; missing: string[] }> {
  const { values, missing } = await resolveSecrets(ctx, fleetId, service.id, service.secretRefs)
  return { env: { ...service.env, ...values }, missing }
}

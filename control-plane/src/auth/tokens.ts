import { randomUUID } from 'node:crypto'
import type { Redis } from 'ioredis'
import type { FastifyInstance } from 'fastify'

export const ACCESS_TTL_SEC = 15 * 60
export const REFRESH_TTL_SEC = 30 * 24 * 60 * 60

export type AccessClaims = { sub: string; typ: 'access' }
export type RefreshClaims = { sub: string; typ: 'refresh'; jti: string }

const refreshKey = (jti: string) => `refresh:${jti}`

/**
 * Refresh tokens are JWTs whose jti is also recorded in Redis. Signing alone
 * would make them impossible to revoke, so the Redis entry is the source of
 * truth for "is this still valid" — deleting it logs the session out for real.
 */
export async function issueTokens(app: FastifyInstance, redis: Redis, userId: string) {
  const jti = randomUUID()
  const accessToken = app.jwt.sign({ sub: userId, typ: 'access' } satisfies AccessClaims, {
    expiresIn: ACCESS_TTL_SEC,
  })
  const refreshToken = app.jwt.sign(
    { sub: userId, typ: 'refresh', jti } satisfies RefreshClaims,
    { expiresIn: REFRESH_TTL_SEC }
  )
  await redis.set(refreshKey(jti), userId, 'EX', REFRESH_TTL_SEC)
  return { accessToken, refreshToken, expiresIn: ACCESS_TTL_SEC }
}

/** Single-use: consuming a refresh token immediately invalidates it. */
export async function consumeRefresh(redis: Redis, jti: string): Promise<string | null> {
  const key = refreshKey(jti)
  const userId = await redis.get(key)
  if (!userId) return null
  await redis.del(key)
  return userId
}

export async function revokeAllRefresh(redis: Redis, userId: string): Promise<number> {
  // Session counts per user are tiny; a scan is cheaper than a second index.
  let cursor = '0'
  let removed = 0
  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', 'refresh:*', 'COUNT', 200)
    cursor = next
    if (keys.length) {
      const owners = await redis.mget(...keys)
      const mine = keys.filter((_, i) => owners[i] === userId)
      if (mine.length) removed += await redis.del(...mine)
    }
  } while (cursor !== '0')
  return removed
}

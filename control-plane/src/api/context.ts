import { Redis } from 'ioredis'
import { createDb, type Db } from '../db/client.js'
import { HeartbeatTracker } from '../heartbeat/tracker.js'
import type { Config } from '../config.js'

export type AppContext = {
  config: Config
  db: Db
  sql: ReturnType<typeof createDb>['sql']
  redis: Redis
  heartbeats: HeartbeatTracker
}

export function createContext(config: Config): AppContext {
  const { db, sql } = createDb(config.DATABASE_URL)
  const redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null })
  const heartbeats = new HeartbeatTracker(
    redis,
    config.HEARTBEAT_INTERVAL_SEC,
    config.HEARTBEAT_MISS_THRESHOLD
  )
  return { config, db, sql, redis, heartbeats }
}

export async function closeContext(ctx: AppContext): Promise<void> {
  await ctx.sql.end({ timeout: 5 })
  ctx.redis.disconnect()
}

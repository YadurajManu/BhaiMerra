import { Redis } from 'ioredis'
import { createDb, type Db } from '../db/client.js'
import { HeartbeatTracker } from '../heartbeat/tracker.js'
import { BuildxRunner } from '../build/buildx.js'
import type { BuildRunner } from '../build/runner.js'
import type { Config } from '../config.js'

export type AppContext = {
  config: Config
  db: Db
  sql: ReturnType<typeof createDb>['sql']
  redis: Redis
  heartbeats: HeartbeatTracker
  builds: BuildRunner
}

export function createContext(config: Config): AppContext {
  const { db, sql } = createDb(config.DATABASE_URL)
  const redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null })
  const heartbeats = new HeartbeatTracker(
    redis,
    config.HEARTBEAT_INTERVAL_SEC,
    config.HEARTBEAT_MISS_THRESHOLD
  )
  const builds = new BuildxRunner({
    registry: config.REGISTRY_URL,
    builder: config.BUILDX_BUILDER,
    workdir: config.BUILD_WORKDIR,
    pushToRegistry: Boolean(config.REGISTRY_URL),
    timeoutMs: config.BUILD_TIMEOUT_MS,
  })

  return { config, db, sql, redis, heartbeats, builds }
}

export async function closeContext(ctx: AppContext): Promise<void> {
  await ctx.sql.end({ timeout: 5 })
  ctx.redis.disconnect()
}

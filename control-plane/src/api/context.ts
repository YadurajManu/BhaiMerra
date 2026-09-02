import { Redis } from 'ioredis'
import { createDb, type Db } from '../db/client.js'
import { HeartbeatTracker } from '../heartbeat/tracker.js'
import { BuildxRunner } from '../build/buildx.js'
import type { BuildRunner } from '../build/runner.js'
import type { GitHubConfig } from '../github/app.js'
import type { Config } from '../config.js'
import { TunnelRegistry } from '../tunnel/registry.js'
import { createEmailSender, type EmailSender } from '../email/sender.js'

export type AppContext = {
  config: Config
  db: Db
  sql: ReturnType<typeof createDb>['sql']
  redis: Redis
  heartbeats: HeartbeatTracker
  builds: BuildRunner
  /** null when no GitHub App is configured — private repos simply will not work. */
  github: GitHubConfig | null
  tunnels: TunnelRegistry
  /**
   * Never null. When no provider is configured this logs instead of sending,
   * so no call site has to branch on whether email exists.
   */
  email: EmailSender
}

export function createContext(
  config: Config,
  log?: { info: (o: unknown, m: string) => void; warn: (o: unknown, m: string) => void }
): AppContext {
  const { db, sql } = createDb(config.DATABASE_URL)
  const redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null })
  const heartbeats = new HeartbeatTracker(
    redis,
    config.HEARTBEAT_INTERVAL_SEC,
    config.HEARTBEAT_MISS_THRESHOLD
  )
  const builds = new BuildxRunner({
    registry: config.REGISTRY_URL,
    credentials: config.REGISTRY_CREDENTIALS,
    builder: config.BUILDX_BUILDER,
    cacheMode: config.BUILDX_CACHE_MODE,
    workdir: config.BUILD_WORKDIR,
    pushToRegistry: Boolean(config.REGISTRY_URL),
    timeoutMs: config.BUILD_TIMEOUT_MS,
  })

  const github = config.GITHUB_APP_ID
    ? {
        appId: config.GITHUB_APP_ID,
        privateKeyPath: config.GITHUB_APP_PRIVATE_KEY_PATH,
        clientId: config.GITHUB_APP_CLIENT_ID,
        slug: config.GITHUB_APP_SLUG,
      }
    : null

  const email = createEmailSender(config, log)

  const ctx: Partial<AppContext> = { config, db, sql, redis, heartbeats, builds, github, email }
  ctx.tunnels = new TunnelRegistry(ctx as AppContext)

  return ctx as AppContext
}

export async function closeContext(ctx: AppContext): Promise<void> {
  await ctx.sql.end({ timeout: 5 })
  ctx.redis.disconnect()
}

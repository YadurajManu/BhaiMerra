import { z } from 'zod'

/**
 * Fail fast and loudly on bad configuration. A control plane that boots with
 * a missing master key and only discovers it when someone stores a secret is
 * worse than one that refuses to start.
 */
const schema = z.object({
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  JWT_SECRET: z.string().min(16, 'JWT_SECRET must be at least 16 characters'),
  SECRETS_MASTER_KEY: z
    .string()
    .min(1)
    .refine((v) => Buffer.from(v, 'base64').length === 32, {
      message: 'SECRETS_MASTER_KEY must be 32 bytes, base64 encoded (openssl rand -base64 32)',
    }),
  HEARTBEAT_INTERVAL_SEC: z.coerce.number().int().min(1).max(300).default(5),
  HEARTBEAT_MISS_THRESHOLD: z.coerce.number().int().min(1).max(20).default(3),
  /** Publicly reported to agents and diagnostics; set during release builds. */
  CONTROL_PLANE_VERSION: z.string().max(32).default('0.1.0'),
  /**
   * Email delivery. Both are optional and only do anything together: without
   * them the control plane runs normally and alert rules with an email channel
   * log instead of sending, which is the right default for a self-hoster who
   * never wanted mail in the first place.
   */
  RESEND_API_KEY: z.string().optional(),
  /** Envelope sender. Must be on a domain verified in Resend, or every send 403s. */
  MAIL_FROM: z.string().optional(),
  REGISTRY_URL: z.string().optional(),
  REGISTRY_CREDENTIALS: z.string().optional(),
  BUILDX_BUILDER: z.string().optional(),
  /**
   * How much build cache to push back to the registry. "max" reuses the most
   * between builds; "min" uploads far less, which is what you want when the
   * registry is behind a proxy that caps request bodies — Cloudflare's free
   * plan rejects anything over 100MB. "off" disables the export.
   */
  BUILDX_CACHE_MODE: z.enum(['max', 'min', 'off']).default('max'),
  /** Root the build runner checks out repositories into. */
  BUILD_WORKDIR: z.string().default('/tmp/fleet-os/builds'),
  /**
   * Where volume backups are stored. Deliberately not under BUILD_WORKDIR:
   * that is scratch space and gets cleaned, and a backup is the one thing here
   * that cannot be regenerated.
   */
  BACKUP_DIR: z.string().default('/var/lib/fleet-os/backups'),
  BUILD_TIMEOUT_MS: z.coerce.number().int().default(20 * 60_000),
  /** Differs between source (src/db/migrations) and the built image. */
  MIGRATIONS_DIR: z.string().default('src/db/migrations'),
  /** Served at /install, with this control plane's address substituted in. */
  INSTALL_SCRIPT_PATH: z.string().default('../scripts/install.sh'),
  /**
   * The public API origin agents use. Required when /install is also exposed
   * through a dashboard reverse proxy whose API lives under /api.
   */
  PUBLIC_API_URL: z.string().url().optional(),
  /** Cross-compiled agent binaries, served at /install/fleet-agent-<os>-<arch>. */
  AGENT_BIN_DIR: z.string().default('../agent/dist'),
  PORT: z.coerce.number().int().default(8080),
  /** Public edge. Separate listener from the API, which is not internet-facing. */
  INGRESS_PORT: z.coerce.number().int().default(8081),
  INGRESS_ENABLED: z.coerce.boolean().default(true),
  /** Zone for managed hostnames: <service>.<fleet>.<zone> */
  INGRESS_ZONE: z.string().default('fleetos.app'),
  /** Shared secret for git webhook signatures. Unset disables verification. */
  WEBHOOK_SECRET: z.string().min(16).optional(),
  /** App ID and Client ID are public identifiers; only the key is secret. */
  GITHUB_APP_ID: z.string().optional(),
  GITHUB_APP_CLIENT_ID: z.string().optional(),
  GITHUB_APP_CLIENT_SECRET: z.string().optional(),
  GITHUB_APP_PRIVATE_KEY_PATH: z.string().default('./github-app.pem'),
  /**
   * The App's URL slug, from https://github.com/apps/<slug>. Needed to send a
   * user into the install flow; without it they must find the App themselves
   * and the installation cannot be bound to their org automatically.
   */
  GITHUB_APP_SLUG: z.string().optional(),
  /**
   * Where to send a browser after GitHub redirects back from an install.
   * Falls back to the request's own origin, which is right for a control plane
   * serving the dashboard from the same host.
   */
  PUBLIC_DASHBOARD_URL: z.string().url().optional(),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
})

export type Config = z.infer<typeof schema>

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env)
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  ${i.path.join('.')}: ${i.message}`)
      .join('\n')
    throw new Error(`Invalid control-plane configuration:\n${issues}`)
  }
  return parsed.data
}

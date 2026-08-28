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
  REGISTRY_URL: z.string().optional(),
  REGISTRY_CREDENTIALS: z.string().optional(),
  BUILDX_BUILDER: z.string().optional(),
  /** Root the build runner checks out repositories into. */
  BUILD_WORKDIR: z.string().default('/tmp/fleet-os/builds'),
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

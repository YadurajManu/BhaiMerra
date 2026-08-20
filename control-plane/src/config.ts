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
  REGISTRY_URL: z.string().optional(),
  REGISTRY_CREDENTIALS: z.string().optional(),
  BUILDX_BUILDER: z.string().optional(),
  /** Root the build runner checks out repositories into. */
  BUILD_WORKDIR: z.string().default('/tmp/fleet-os/builds'),
  BUILD_TIMEOUT_MS: z.coerce.number().int().default(20 * 60_000),
  PORT: z.coerce.number().int().default(8080),
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

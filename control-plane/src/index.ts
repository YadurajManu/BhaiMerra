import 'dotenv/config'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import { loadConfig } from './config.js'
import { createContext, closeContext } from './api/context.js'
import { buildServer } from './server.js'
import { startSweeper } from './heartbeat/sweeper.js'
import { dispatchEvent } from './alerting/dispatch.js'
import { startIngress } from './ingress/proxy.js'

const config = loadConfig()
const ctx = createContext(config)
const app = await buildServer(ctx)

// Migrate before serving. A container that boots against an un-migrated
// database answers every request with an internal error, and the cause is
// three layers down. Drizzle's migrator takes a lock, so several instances
// starting at once is safe.
try {
  await migrate(ctx.db, { migrationsFolder: config.MIGRATIONS_DIR })
  app.log.info({ dir: config.MIGRATIONS_DIR }, 'database migrations applied')
} catch (err) {
  app.log.fatal({ err }, 'could not migrate the database — refusing to start')
  process.exit(1)
}

const sweeper = startSweeper(ctx, {
  log: app.log,
  onEvent: async (event) => {
    app.log.info({ event }, 'fleet event')
    // Delivery failures are logged inside dispatchEvent and never rethrown:
    // an unreachable Discord webhook must not stop the sweeper from finding
    // the next dead node.
    await dispatchEvent(ctx, event, { log: app.log, email: ctx.email })
  },
})

// The public edge listens separately from the API: this port faces the
// internet, and the control-plane API must not.
const ingress = config.INGRESS_ENABLED
  ? await startIngress(ctx, { port: config.INGRESS_PORT, log: app.log })
  : null
if (ingress) {
  app.log.info({ port: ingress.port, zone: config.INGRESS_ZONE }, 'ingress listening')
}

const shutdown = async (signal: string) => {
  app.log.info({ signal }, 'shutting down')
  sweeper.stop()
  await ingress?.close()
  await app.close()
  await closeContext(ctx)
  process.exit(0)
}
process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))

await app.listen({ port: config.PORT, host: config.HOST })

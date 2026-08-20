import 'dotenv/config'
import { loadConfig } from './config.js'
import { createContext, closeContext } from './api/context.js'
import { buildServer } from './server.js'
import { startSweeper } from './heartbeat/sweeper.js'
import { dispatchEvent } from './alerting/dispatch.js'

const config = loadConfig()
const ctx = createContext(config)
const app = await buildServer(ctx)

const sweeper = startSweeper(ctx, {
  log: app.log,
  onEvent: async (event) => {
    app.log.info({ event }, 'fleet event')
    // Delivery failures are logged inside dispatchEvent and never rethrown:
    // an unreachable Discord webhook must not stop the sweeper from finding
    // the next dead node.
    await dispatchEvent(ctx, event, { log: app.log })
  },
})

const shutdown = async (signal: string) => {
  app.log.info({ signal }, 'shutting down')
  sweeper.stop()
  await app.close()
  await closeContext(ctx)
  process.exit(0)
}
process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))

await app.listen({ port: config.PORT, host: config.HOST })

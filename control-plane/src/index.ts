import 'dotenv/config'
import { loadConfig } from './config.js'
import { createContext, closeContext } from './api/context.js'
import { buildServer } from './server.js'
import { startSweeper } from './heartbeat/sweeper.js'

const config = loadConfig()
const ctx = createContext(config)
const app = await buildServer(ctx)

const sweeper = startSweeper(ctx, {
  log: app.log,
  onEvent: (event) => {
    // Phase 3 routes this to the alerting engine. Until then it is at least
    // on the record rather than silently dropped.
    app.log.warn({ event }, 'fleet event')
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

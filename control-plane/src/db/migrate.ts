import 'dotenv/config'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import { createDb } from './client.js'
import { loadConfig } from '../config.js'

const cfg = loadConfig()
const { sql, db } = createDb(cfg.DATABASE_URL)

await migrate(db, { migrationsFolder: 'src/db/migrations' })
console.log('migrations applied')
await sql.end()

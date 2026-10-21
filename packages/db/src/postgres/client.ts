import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import * as tables from './tables.ts'

export const databaseUrl = process.env.DATABASE_URL ?? 'postgres://spyria:spyria@localhost:5434/spyria'

const poolSettings = {
  max: Number(process.env.DATABASE_POOL_MAX ?? 10),
  idle_timeout: Number(process.env.DATABASE_IDLE_TIMEOUT_SECONDS ?? 60),
  max_lifetime: Number(process.env.DATABASE_MAX_LIFETIME_SECONDS ?? 1800),
  connection: { application_name: process.env.DATABASE_APPLICATION_NAME ?? 'spyria-server' },
}

export const createDatabase = (url = databaseUrl) =>
  drizzle({ client: postgres(url, { onnotice: () => {}, ...poolSettings }), relations: tables.relations })

export type Database = ReturnType<typeof createDatabase>

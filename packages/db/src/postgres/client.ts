import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import * as tables from './tables.ts'

export const databaseUrl = process.env.DATABASE_URL ?? 'postgres://spyria:spyria@localhost:5434/spyria'

export const createDatabase = (url = databaseUrl) =>
  drizzle({ client: postgres(url, { onnotice: () => {} }), relations: tables.relations })

export type Database = ReturnType<typeof createDatabase>

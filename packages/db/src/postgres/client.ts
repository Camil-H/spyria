import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import * as tables from './tables.ts'

export const databaseUrl = process.env.DATABASE_URL ?? 'postgres://hq:hq@localhost:5434/hq'

export const createDatabase = (url = databaseUrl) =>
  drizzle({ client: postgres(url, { onnotice: () => {} }), relations: tables.relations })

export type Database = ReturnType<typeof createDatabase>

import { migrate } from 'drizzle-orm/postgres-js/migrator'
import { createDatabase, databaseUrl } from './client.ts'

export const migrateDatabase = (database: ReturnType<typeof createDatabase>) =>
  migrate(database, { migrationsFolder: new URL('../../drizzle', import.meta.url).pathname })

if (import.meta.main) {
  const database = createDatabase(`${databaseUrl}${databaseUrl.includes('?') ? '&' : '?'}search_path=public`)
  await migrateDatabase(database)
  await database.$client.end()
}

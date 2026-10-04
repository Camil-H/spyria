import { createDatabase, type Database } from '@hq/db/postgres'
import { databaseUrlOf } from '@hq/db/testing'
import { createApp } from './app.ts'

if (process.env.HQ_DEV_AUTH !== '1') throw new Error('The test server runs only with HQ_DEV_AUTH=1')

const databaseByNameCache = new Map<string, Database>()
const databaseByName = (databaseName: string) => {
  const database = databaseByNameCache.get(databaseName) ?? createDatabase(databaseUrlOf(databaseName))
  databaseByNameCache.set(databaseName, database)
  return database
}

const app = createApp({
  database: createDatabase(),
  tokenSecret: `${crypto.randomUUID()}${crypto.randomUUID()}`,
  isDevAuthEnabled: true,
  databaseByName,
})

export default { port: Number(process.env.PORT ?? 3100), hostname: '0.0.0.0', fetch: app.fetch }

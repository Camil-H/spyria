import { createDatabase, type Database } from '@hq/db/postgres'
import { databaseUrlOf } from '@hq/db/testing'
import { createApp } from './app.ts'
import { startJobWorker } from './job-worker.ts'

if (process.env.HQ_DEV_AUTH !== '1') throw new Error('The test server runs only with HQ_DEV_AUTH=1')

type ServedDatabase = { database: Database; jobWorker: ReturnType<typeof startJobWorker> }
const servedDatabaseByName = new Map<string, ServedDatabase>()
const databaseByName = (databaseName: string) => {
  const served = servedDatabaseByName.get(databaseName)
  if (served) return served.database
  const database = createDatabase(databaseUrlOf(databaseName))
  servedDatabaseByName.set(databaseName, { database, jobWorker: startJobWorker(database) })
  return database
}

const releaseDatabase = async (databaseName: string) => {
  const served = servedDatabaseByName.get(databaseName)
  servedDatabaseByName.delete(databaseName)
  await served?.jobWorker.stop()
  await served?.database.$client.end({ timeout: 5 })
}

const app = createApp({
  database: createDatabase(),
  tokenSecret: `${crypto.randomUUID()}${crypto.randomUUID()}`,
  isDevAuthEnabled: true,
  databaseByName,
}).post('/test/release-database', async (context) => {
  await releaseDatabase(context.req.query('db') ?? '')
  return context.body(null, 204)
})

export default { port: Number(process.env.PORT ?? 3100), hostname: '0.0.0.0', fetch: app.fetch }

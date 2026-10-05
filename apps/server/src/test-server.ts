import { createDatabase, type Database } from '@hq/db/postgres'
import { databaseUrlOf } from '@hq/db/testing'
import { websocket } from 'hono/bun'
import { setCookie } from 'hono/cookie'
import { createApp } from './app.ts'
import { sessionCookieOptions, setSessionCookie, testCookie } from './auth/routes.ts'
import { openSessions } from './auth/sessions.ts'
import { startJobWorker } from './job-worker.ts'
import { createRuntimeHostGateway } from './runtime-hosts/gateway.ts'
import { issueTestSession, testAuthSettings } from './testing.ts'

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

const { appOrigin } = testAuthSettings

const runtimeHosts = createRuntimeHostGateway({
  databases: () => [...servedDatabaseByName.values()].map((served) => served.database),
})

const app = createApp({
  database: createDatabase(),
  ...testAuthSettings,
  testDatabaseByName: databaseByName,
  runtimeHosts,
})
  .post('/test/release-database', async (context) => {
    await releaseDatabase(context.req.query('db') ?? '')
    return context.body(null, 204)
  })
  .post('/test/sign-in', async (context) => {
    const { db = '', user, tokenSeconds } = context.req.query()
    const testSettings = { db, user, tokenSeconds: tokenSeconds ? Number(tokenSeconds) : undefined }
    setCookie(context, testCookie, JSON.stringify(testSettings), sessionCookieOptions(appOrigin))
    if (user)
      for (const session of await openSessions(databaseByName(db), user)) setSessionCookie(context, appOrigin, session)
    return context.body(null, 204)
  })
  .post('/test/token', async (context) => {
    const { db = '', user = '', workspace = '' } = context.req.query()
    return context.json(await issueTestSession(databaseByName(db), workspace, user, db))
  })

export default { port: Number(process.env.PORT ?? 3100), hostname: '0.0.0.0', fetch: app.fetch, websocket }

import { createDatabase, type Database } from '@hq/db/postgres'
import { databaseUrlOf } from '@hq/db/testing'
import { setCookie } from 'hono/cookie'
import { createApp } from './app.ts'
import { sessionCookieOptions, setSessionCookie, testCookie } from './auth/routes.ts'
import { issueSessionToken } from './auth/session-tokens.ts'
import { openSessions } from './auth/sessions.ts'
import { startJobWorker } from './job-worker.ts'

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

const port = Number(process.env.PORT ?? 3100)
const appOrigin = process.env.HQ_APP_ORIGIN ?? 'http://localhost:5190'
const tokenSecret = `${crypto.randomUUID()}${crypto.randomUUID()}`

const app = createApp({
  database: createDatabase(),
  tokenSecret,
  oidc: { issuer: 'http://localhost:5556/dex', clientId: 'hq', redirectUri: `http://localhost:${port}/auth/callback` },
  appOrigin,
  testDatabaseByName: databaseByName,
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
    const { db = '', user = '', workspace } = context.req.query()
    const [session] = await openSessions(databaseByName(db), user, workspace)
    if (!session) return context.json({ error: 'forbidden' }, 403)
    return context.json({
      ...(await issueSessionToken(tokenSecret, session, { databaseName: db })),
      sessionId: session.sessionId,
    })
  })

export default { port, hostname: '0.0.0.0', fetch: app.fetch }

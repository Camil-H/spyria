import { createDatabase, type Database } from '@hq/db/postgres'
import { databaseUrlOf } from '@hq/db/testing'
import { schema } from '@hq/db/zero'
import { chatId, workspaceId } from '@hq/kernel'
import { createRuntimeTransactor, ensureRuntimeRunning, type SandboxProvider } from '@hq/runtime/server'
import { zeroDrizzle } from '@rocicorp/zero/server/adapters/drizzle'
import { websocket } from 'hono/bun'
import { setCookie } from 'hono/cookie'
import { createAgentBridge } from './agent-bridge/bridge.ts'
import { createApp } from './app.ts'
import { sessionCookieOptions, setSessionCookie, testCookie } from './auth/routes.ts'
import { openSessions } from './auth/sessions.ts'
import { createFakeLlm, type FakeLlmScript } from './fake-llm.ts'
import { startJobWorker } from './job-worker.ts'
import { createRuntimeHostGateway } from './runtime-hosts/gateway.ts'
import { issueTestSession, testAuthSettings } from './testing.ts'

const port = Number(process.env.PORT ?? 3100)

type ServedDatabase = { database: Database; jobWorker: ReturnType<typeof startJobWorker> }
const servedDatabaseByName = new Map<string, ServedDatabase>()
const databasesFailingCreation = new Set<string>()
const sandboxProviderOf = (databaseName: string): SandboxProvider => ({
  ...runtimeHosts.sandboxProvider,
  create: async (sandbox) => {
    if (databasesFailingCreation.has(databaseName)) throw new Error('Runtime creation fails in this test')
    await runtimeHosts.sandboxProvider.create(sandbox)
  },
})
const databaseByName = (databaseName: string) => {
  const served = servedDatabaseByName.get(databaseName)
  if (served) return served.database
  const database = createDatabase(databaseUrlOf(databaseName))
  servedDatabaseByName.set(databaseName, {
    database,
    jobWorker: startJobWorker(database, { sandboxProvider: sandboxProviderOf(databaseName), agentBridge }),
  })
  return database
}

const releaseDatabase = async (databaseName: string) => {
  const served = servedDatabaseByName.get(databaseName)
  servedDatabaseByName.delete(databaseName)
  await served?.jobWorker.stop()
  if (served) agentBridge.release(served.database)
  await served?.database.$client.end({ timeout: 5 })
}

const { appOrigin } = testAuthSettings

const runtimeHosts = createRuntimeHostGateway({
  databases: () => [...servedDatabaseByName.values()].map((served) => served.database),
  afterHello: (database, host) => agentBridge.forDatabase(database).promptWaiting(host),
})

const agentBridge = createAgentBridge({
  sandboxProvider: runtimeHosts.sandboxProvider,
  llm: { baseUrl: `http://host.docker.internal:${port}/fake-llm/v1`, model: 'openai/fake' },
})

const scriptByChat = new Map<string, FakeLlmScript>()
const scriptOfToken = async (token: string) => {
  for (const [databaseName, { database }] of servedDatabaseByName) {
    const [runtime] = await database.$client`
      select runtimes.chat_id from runtimes join placeholder_secrets on placeholder_secrets.workspace_id = runtimes.workspace_id
        and placeholder_secrets.ref = runtimes.llm_token_ref
      where placeholder_secrets.value = ${token}`
    if (runtime) return scriptByChat.get(`${databaseName}/${runtime.chat_id}`)
  }
}

const app = createApp({
  database: createDatabase(),
  ...testAuthSettings,
  testDatabaseByName: databaseByName,
  runtimeHosts,
  agentBridge,
  fakeLlm: createFakeLlm(scriptOfToken),
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
  .post('/test/fake-llm-script', async (context) => {
    const { db = '', chat } = context.req.query()
    if (chat) scriptByChat.set(`${db}/${chat}`, await context.req.json())
    else for (const key of scriptByChat.keys()) if (key.startsWith(`${db}/`)) scriptByChat.delete(key)
    return context.body(null, 204)
  })
  .post('/test/runtime-creation', (context) => {
    const { db = '', failing } = context.req.query()
    if (failing === 'true') databasesFailingCreation.add(db)
    else databasesFailingCreation.delete(db)
    return context.body(null, 204)
  })
  .post('/test/runtime', async (context) => {
    const { db = '', chat = '' } = context.req.query()
    await zeroDrizzle(schema, databaseByName(db)).transaction((tx) =>
      ensureRuntimeRunning(
        { transactor: createRuntimeTransactor(tx) },
        { workspaceId: workspaceId('workspace-acme'), chatId: chatId(chat), id: crypto.randomUUID(), now: Date.now() },
      ),
    )
    return context.body(null, 204)
  })
  .post('/test/token', async (context) => {
    const { db = '', user = '', workspace = '' } = context.req.query()
    return context.json(await issueTestSession(databaseByName(db), workspace, user, db))
  })

export default { port, hostname: '0.0.0.0', fetch: app.fetch, websocket }

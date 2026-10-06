import { createDatabase, type Database } from '@hq/db/postgres'
import { databaseUrlOf } from '@hq/db/testing'
import { schema } from '@hq/db/zero'
import { chatId, workspaceId } from '@hq/kernel'
import { createLlmGateway } from '@hq/profile/server'
import { createRuntimeTransactor, ensureRuntimeRunning, type SandboxProvider } from '@hq/runtime/server'
import { zeroDrizzle } from '@rocicorp/zero/server/adapters/drizzle'
import { websocket } from 'hono/bun'
import { setCookie } from 'hono/cookie'
import { createAgentBridge } from './agent-bridge/bridge.ts'
import { createApp, defaultLlm } from './app.ts'
import { sessionCookieOptions, setSessionCookie, testCookie } from './auth/routes.ts'
import { openSessions } from './auth/sessions.ts'
import { createFakeLlm, type FakeLlmScript } from './fake-llm.ts'
import { startJobWorker } from './job-worker.ts'
import { createModelCallRelay } from './llm-relay.ts'
import { createRuntimeHostGateway } from './runtime-hosts/gateway.ts'
import { issueTestSession, testAuthSettings } from './testing.ts'

const port = Number(process.env.PORT ?? 3100)

type ServedDatabase = { database: Database; jobWorker: ReturnType<typeof startJobWorker> }
const servedDatabaseByName = new Map<string, ServedDatabase>()
const databasesFailingCreation = new Set<string>()
const databasesWithoutGateway = new Set<string>()
const nameOf = (database: Database) =>
  [...servedDatabaseByName].find(([, served]) => served.database === database)?.[0] ?? ''
const llmGateway = createLlmGateway({
  url: process.env.HQ_GATEWAY_URL ?? '',
  adminUser: process.env.HQ_GATEWAY_ADMIN_USER ?? '',
  adminPassword: process.env.HQ_GATEWAY_ADMIN_PASSWORD ?? '',
})
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
    jobWorker: startJobWorker(database, { sandboxProvider: sandboxProviderOf(databaseName), agentBridge, llmGateway }),
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
  relayModelCall: createModelCallRelay({
    gatewayUrlOf: (database) => (databasesWithoutGateway.has(nameOf(database)) ? 'http://127.0.0.1:9' : llmGateway.url),
    llmGateway,
    agentBridge: () => agentBridge,
    providerHeadersOf: (database, chat) => ({ 'x-bf-eh-x-hq-chat': `${nameOf(database)}/${chat.chatId}` }),
  }),
})

const agentBridge = createAgentBridge({ sandboxProvider: runtimeHosts.sandboxProvider, llm: defaultLlm })

const scriptByChat = new Map<string, FakeLlmScript>()

const app = createApp({
  database: createDatabase(),
  ...testAuthSettings,
  testDatabaseByName: databaseByName,
  llmGateway,
  runtimeHosts,
  agentBridge,
  fakeLlm: createFakeLlm((request) => scriptByChat.get(request.headers.get('x-hq-chat') ?? '')),
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
  .post('/test/gateway', (context) => {
    const { db = '', reachable } = context.req.query()
    if (reachable === 'false') databasesWithoutGateway.add(db)
    else databasesWithoutGateway.delete(db)
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

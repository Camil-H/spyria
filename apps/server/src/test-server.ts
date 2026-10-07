import { createDatabase, type Database } from '@hq/db/postgres'
import { databaseUrlOf } from '@hq/db/testing'
import { schema } from '@hq/db/zero'
import { chatId, workspaceId } from '@hq/kernel'
import { createLlmGateway } from '@hq/profile/server'
import { createRuntimeTransactor, ensureRuntimeRunning, type SandboxProvider } from '@hq/runtime/server'
import { createBifrostUsageLogs, syncUsageNow } from '@hq/usage/server'
import { zeroDrizzle } from '@rocicorp/zero/server/adapters/drizzle'
import { websocket } from 'hono/bun'
import { setCookie } from 'hono/cookie'
import { createAgentBridge } from './agent-bridge/bridge.ts'
import { createFakeAgentServer } from './agent-bridge/fake-agent-server.ts'
import { createApp, defaultLlm } from './app.ts'
import { sessionCookieOptions, setSessionCookie, testCookie } from './auth/routes.ts'
import { openSessions } from './auth/sessions.ts'
import { createFakeLlm, type FakeLlmScript } from './fake-llm.ts'
import { createFakeMcp } from './fake-mcp.ts'
import { startJobWorker } from './job-worker.ts'
import { createModelCallRelay } from './llm-relay.ts'
import { createRuntimeHostGateway } from './runtime-hosts/gateway.ts'
import { createFakeHosts, type FakeHost, issueTestSession, testAuthSettings } from './testing.ts'

const port = Number(process.env.PORT ?? 3100)
const fakeMcpPort = Number(process.env.HQ_FAKE_MCP_PORT ?? 3101)
const testToolServers = ['fake', 'GitHub', 'Slack', 'Notion', 'Linear']
Bun.serve({ port: fakeMcpPort, fetch: createFakeMcp().fetch })

type ServedDatabase = {
  database: Database
  jobWorker: ReturnType<typeof startJobWorker>
  syncUsage: () => Promise<void>
  usageTimer: ReturnType<typeof setInterval>
}
const servedDatabaseByName = new Map<string, ServedDatabase>()
const databasesFailingCreation = new Set<string>()
const databasesWithoutGateway = new Set<string>()
const fakeHostByDatabase = new Map<string, { host: FakeHost; isOnline: boolean }>()
const nameOf = (database: Database) =>
  [...servedDatabaseByName].find(([, served]) => served.database === database)?.[0] ?? ''
const gatewaySettings = {
  url: process.env.HQ_GATEWAY_URL ?? '',
  adminUser: process.env.HQ_GATEWAY_ADMIN_USER ?? '',
  adminPassword: process.env.HQ_GATEWAY_ADMIN_PASSWORD ?? '',
}
const llmGateway = createLlmGateway(gatewaySettings)
const usageSyncIntervalMilliseconds = 2_000
const fakeAgentServerBootMilliseconds = Number(process.env.HQ_FAKE_AGENT_SERVER_BOOT_MILLISECONDS ?? 1_500)
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
  const usageLogs = createBifrostUsageLogs({ ...gatewaySettings, labels: { database: databaseName } })
  const zeroDatabase = zeroDrizzle(schema, database)
  const syncUsage = () =>
    syncUsageNow(usageLogs, {
      workspaceId: workspaceId('workspace-acme'),
      transact: (work) => zeroDatabase.transaction(work),
    })
  servedDatabaseByName.set(databaseName, {
    database,
    jobWorker: startJobWorker(database, { sandboxProvider: sandboxProviderOf(databaseName), agentBridge, llmGateway }),
    syncUsage,
    usageTimer: setInterval(() => syncUsage().catch(() => {}), usageSyncIntervalMilliseconds),
  })
  return database
}

const releaseDatabase = async (databaseName: string) => {
  const fakeHost = fakeHostByDatabase.get(databaseName)
  fakeHostByDatabase.delete(databaseName)
  if (fakeHost?.isOnline) await fakeHost.host.disconnect().catch(() => {})
  const served = servedDatabaseByName.get(databaseName)
  servedDatabaseByName.delete(databaseName)
  clearInterval(served?.usageTimer)
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
    providerHeadersOf: (database, chat) => ({
      'x-bf-eh-x-hq-chat': `${nameOf(database)}/${chat.chatId}`,
      'x-bf-dim-database': nameOf(database),
    }),
  }),
})

const agentBridge = createAgentBridge({ sandboxProvider: runtimeHosts.sandboxProvider, llm: defaultLlm })

const scriptByChat = new Map<string, { script: FakeLlmScript; used: PromiseWithResolvers<boolean> }>()
const scriptUseMilliseconds = 30_000

const app = createApp({
  database: createDatabase(),
  ...testAuthSettings,
  testDatabaseByName: databaseByName,
  llmGateway,
  runtimeHosts,
  agentBridge,
  fakeLlm: createFakeLlm((request) => {
    const chatScript = scriptByChat.get(request.headers.get('x-hq-chat') ?? '')
    chatScript?.used.resolve(true)
    return chatScript?.script
  }),
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
    if (!chat) {
      for (const key of scriptByChat.keys()) if (key.startsWith(`${db}/`)) scriptByChat.delete(key)
      return context.body(null, 204)
    }
    const previous = scriptByChat.get(`${db}/${chat}`)
    const wasUsed = await Promise.race([
      previous?.used.promise ?? true,
      Bun.sleep(scriptUseMilliseconds).then(() => false),
    ])
    if (!wasUsed) return context.text(`No model call used the previous script of ${chat}`, 409)
    scriptByChat.set(`${db}/${chat}`, { script: await context.req.json(), used: Promise.withResolvers() })
    return context.body(null, 204)
  })
  .post('/test/usage-sync', async (context) => {
    const { db = '' } = context.req.query()
    databaseByName(db)
    await servedDatabaseByName.get(db)?.syncUsage()
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
  .post('/test/fake-host', async (context) => {
    const { db = '', online } = context.req.query()
    let fakeHost = fakeHostByDatabase.get(db)
    if (!fakeHost) {
      const fake = createFakeAgentServer({ modelCall: () => created.modelCall })
      const created = await createFakeHosts({ port, database: databaseByName(db) }).fakeHost('e2e fake host', {
        memoryGibibytes: 16,
        agentServer: fake.agentServer,
        bootMilliseconds: fakeAgentServerBootMilliseconds,
      })
      fakeHost = { host: created, isOnline: true }
      fakeHostByDatabase.set(db, fakeHost)
    }
    if (online === 'false' && fakeHost.isOnline) await fakeHost.host.disconnect()
    if (online === 'true' && !fakeHost.isOnline) await fakeHost.host.connect()
    if (online) fakeHost.isOnline = online === 'true'
    return context.json({ id: fakeHost.host.id })
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
  .post('/test/tool-servers', async (context) => {
    for (const name of testToolServers)
      await llmGateway.setUpToolServer({ name, url: `http://host.docker.internal:${fakeMcpPort}/mcp` })
    return context.body(null, 204)
  })
  .post('/test/token', async (context) => {
    const { db = '', user = '', workspace = '' } = context.req.query()
    return context.json(await issueTestSession(databaseByName(db), workspace, user, db))
  })

export default { port, hostname: '0.0.0.0', fetch: app.fetch, websocket }

import { acme } from '@hq/db'
import { createDatabase, type Database } from '@hq/db/postgres'
import { setModelDirectory } from '@hq/db/server-writes'
import { databaseUrlOf } from '@hq/db/testing'
import { schema } from '@hq/db/zero'
import { addRoutableModels, chatId } from '@hq/kernel'
import { createLlmGateway } from '@hq/profile/server'
import {
  createRuntimeTransactor,
  ensureRuntimeRunning,
  type SandboxProvider,
  stopChatRuntime,
} from '@hq/runtime/server'
import { createBifrostUsageLogs, syncUsageNow } from '@hq/usage/server'
import { zeroDrizzle } from '@rocicorp/zero/server/adapters/drizzle'
import { websocket } from 'hono/bun'
import { setCookie } from 'hono/cookie'
import { createAgentBridge } from '../agent-bridge/bridge.ts'
import { createApp, sessionClassifierOf } from '../app.ts'
import { sessionCookieOptions, setSessionCookie, testCookie } from '../auth/routes.ts'
import { createSecretBox } from '../auth/secret-box.ts'
import { openSessions } from '../auth/sessions.ts'
import { createFakeLlm, type FakeLlmScript, fakeRoutableModels } from '../fake-llm.ts'
import { createGitHubCheckouts } from '../github/github.ts'
import { createGitHubApi } from '../github/github-api.ts'
import { readHqAgentImage } from '../hq-agent-image.ts'
import { startJobWorker } from '../job-worker.ts'
import { createModelCallRelay } from '../llm-relay.ts'
import { createRuntimeHostGateway } from '../runtime-hosts/gateway.ts'
import { fakeGitHubAppId, fakeGitHubClientId, fakeGitHubClientSecret, startFakeGitHub } from './fake-github.ts'
import { createFakeMcp, sharedToolServer } from './fake-mcp.ts'
import { createHqAgentRelay } from './hq-agent-relay.ts'
import {
  createFakeHosts,
  createHolds,
  type FakeHost,
  issueTestSession,
  testAuthSettings,
  testSecretsKey,
} from './testing.ts'

const port = Number(process.env.PORT ?? 3100)
const fakeMcpPort = Number(process.env.HQ_FAKE_MCP_PORT ?? 3101)
const testToolServers = ['fake', 'GitHub', 'Slack', 'Notion', 'Linear']
Bun.serve({ port: fakeMcpPort, fetch: createFakeMcp().fetch })
const fakeGitHub = startFakeGitHub()
const github = { api: createGitHubApi(fakeGitHub.urls), secretBox: createSecretBox(testSecretsKey) }

type ServedDatabase = {
  database: Database
  jobWorker: ReturnType<typeof startJobWorker>
  syncUsage: () => Promise<void>
  usageTimer: ReturnType<typeof setInterval>
}
const servedDatabaseByName = new Map<string, ServedDatabase>()
const databasesFailingCreation = new Set<string>()
const databasesWithoutGateway = new Set<string>()
const bootHoldByDatabase = new Map<string, string>()
const holds = createHolds()
const waitForRelease = (databaseName: string, name: string) => holds.wait(`${databaseName}/${name}`)
const fakeHostByDatabase = new Map<
  string,
  { host: FakeHost; relay: ReturnType<typeof createHqAgentRelay>; isOnline: boolean }
>()
const fakeMachineByDatabase = new Map<string, { host: FakeHost; relay: ReturnType<typeof createHqAgentRelay> }>()
const nameOf = (database: Database) =>
  [...servedDatabaseByName].find(([, served]) => served.database === database)?.[0] ?? ''
const gatewaySettings = {
  url: process.env.HQ_GATEWAY_URL ?? '',
  adminUser: process.env.HQ_GATEWAY_ADMIN_USER ?? '',
  adminPassword: process.env.HQ_GATEWAY_ADMIN_PASSWORD ?? '',
}
const llmGateway = createLlmGateway(gatewaySettings)
setModelDirectory(llmGateway.listedModels)
addRoutableModels(fakeRoutableModels)
const usageSyncIntervalMilliseconds = 2_000
const stubGapMilliseconds = Number(process.env.HQ_STUB_GAP_MS ?? 20)
const defaultBootMilliseconds = 200
const holdUrlOf = (databaseName: string) => `http://localhost:${port}/test/hold?db=${databaseName}`
const bootOf = (databaseName: string) => () => {
  const bootHold = bootHoldByDatabase.get(databaseName)
  return bootHold ? waitForRelease(databaseName, bootHold) : Bun.sleep(defaultBootMilliseconds)
}
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
      workspaceId: acme,
      transact: (work) => zeroDatabase.transaction(work),
    })
  servedDatabaseByName.set(databaseName, {
    database,
    jobWorker: startJobWorker(database, {
      sandboxProvider: sandboxProviderOf(databaseName),
      agentBridge,
      llmGateway,
      retryDelayMilliseconds: 100,
    }),
    syncUsage,
    usageTimer: setInterval(() => syncUsage().catch(() => {}), usageSyncIntervalMilliseconds),
  })
  return database
}

const releaseDatabase = async (databaseName: string) => {
  const fakeHost = fakeHostByDatabase.get(databaseName)
  fakeHostByDatabase.delete(databaseName)
  if (fakeHost?.isOnline) await fakeHost.host.disconnect().catch(() => {})
  await fakeHost?.relay.stop()
  await fakeMachineByDatabase
    .get(databaseName)
    ?.host.disconnect()
    .catch(() => {})
  await fakeMachineByDatabase.get(databaseName)?.relay.stop()
  fakeMachineByDatabase.delete(databaseName)
  const served = servedDatabaseByName.get(databaseName)
  servedDatabaseByName.delete(databaseName)
  clearInterval(served?.usageTimer)
  await served?.jobWorker.stop()
  if (served) agentBridge.release(served.database)
  await served?.database.$client.end({ timeout: 5 })
}

const { appOrigin } = testAuthSettings

const gatewayUrlOf = (database: Database) =>
  databasesWithoutGateway.has(nameOf(database)) ? 'http://127.0.0.1:9' : llmGateway.url
const testHeadersOf = (database: Database, chat: { chatId: string }) => ({
  'x-bf-eh-x-hq-chat': `${nameOf(database)}/${chat.chatId}`,
  'x-bf-dim-database': nameOf(database),
})
const hqAgentImage = (await readHqAgentImage()) ?? `sha256:${'0'.repeat(64)}`
const placement = { hqAgentImage }
const runtimeHosts = createRuntimeHostGateway({
  ...placement,
  databases: () => [...servedDatabaseByName.values()].map((served) => served.database),
  afterHello: (database, host) => agentBridge.forDatabase(database).resumeHost(host),
  relayModelCall: createModelCallRelay({
    gatewayUrlOf,
    llmGateway,
    agentBridge: () => agentBridge,
    providerHeadersOf: testHeadersOf,
  }),
})

const agentBridge = createAgentBridge({
  sandboxProvider: runtimeHosts.sandboxProvider,
  sessionClassifierOf: sessionClassifierOf(llmGateway, { gatewayUrlOf, headersOf: testHeadersOf }),
  resumeAfterMilliseconds: 5_000,
  reopenDelayMilliseconds: 50,
  repositoryCheckoutsOf: (database) => createGitHubCheckouts(database, github),
  ...placement,
})

const scriptByChat = new Map<string, { script: FakeLlmScript; used: PromiseWithResolvers<boolean> }>()
const scriptUseMilliseconds = 30_000
const chatKeyOfPrompt = async (prompt = '') => {
  for (const key of scriptByChat.keys()) {
    const [databaseName = '', chat] = key.split('/')
    const [prompted] = await databaseByName(databaseName).$client`
      select 1 from chats join messages on messages.chat_id = chats.id and messages.id = chats.agent_turn_message_id
      where chats.id = ${chat ?? ''} and strpos(${prompt}, messages.body) > 0`.catch(() => [])
    if (prompted) return key
  }
  return ''
}

const app = createApp({
  database: createDatabase(),
  ...testAuthSettings,
  oidc: { ...testAuthSettings.oidc, issuer: 'http://localhost:5557/dex' },
  testDatabaseByName: databaseByName,
  llmGateway,
  runtimeHosts,
  agentBridge,
  github,
  ...placement,
  fakeLlm: createFakeLlm(async (request, isClassifier, prompt) => {
    const chatKey = request.headers.get('x-hq-chat') ?? (await chatKeyOfPrompt(prompt))
    const chatScript = scriptByChat.get(chatKey)
    if (!isClassifier) chatScript?.used.resolve(true)
    const [databaseName = ''] = chatKey.split('/')
    return chatScript && { ...chatScript.script, held: (name: string) => waitForRelease(databaseName, name) }
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
      if (llmGateway.listedModels().length === 0) await llmGateway.refreshListedModels()
      for (const key of scriptByChat.keys()) if (key.startsWith(`${db}/`)) scriptByChat.delete(key)
      holds.releaseAll(`${db}/`)
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
  .post('/test/fake-boot', (context) => {
    const { db = '', hold } = context.req.query()
    if (hold) bootHoldByDatabase.set(db, hold)
    else bootHoldByDatabase.delete(db)
    return context.body(null, 204)
  })
  .post('/test/hold', async (context) => {
    const { db = '', name = '' } = context.req.query()
    await waitForRelease(db, name)
    return context.body(null, 204)
  })
  .post('/test/reached', async (context) => {
    const { db = '', name = '' } = context.req.query()
    await holds.reached(`${db}/${name}`)
    return context.body(null, 204)
  })
  .post('/test/release', async (context) => {
    const { db = '', name = '' } = context.req.query()
    await holds.release(`${db}/${name}`)
    return context.body(null, 204)
  })
  .post('/test/gateway', (context) => {
    const { db = '', reachable } = context.req.query()
    if (reachable === 'false') databasesWithoutGateway.add(db)
    else databasesWithoutGateway.delete(db)
    return context.body(null, 204)
  })
  .post('/test/fake-host', async (context) => {
    const { db = '', online, forgetSessions, keepAgentsOf } = context.req.query()
    let fakeHost = fakeHostByDatabase.get(db)
    if (!fakeHost) {
      const relay = createHqAgentRelay({
        gapMilliseconds: stubGapMilliseconds,
        holdUrl: holdUrlOf(db),
        modelCall: () => created.modelCall,
      })
      const created = await createFakeHosts({ port, database: databaseByName(db) }).fakeHost('e2e fake host', {
        memoryGibibytes: 16,
        containerAgent: relay.containerAgent,
        boot: bootOf(db),
      })
      fakeHost = { host: created, relay, isOnline: true }
      fakeHostByDatabase.set(db, fakeHost)
    }
    if (forgetSessions === 'true') fakeHost.relay.forgetSessions()
    if (keepAgentsOf !== undefined) await fakeHost.relay.stopAgentsExcept(keepAgentsOf.split(','))
    if (online === 'false' && fakeHost.isOnline) await fakeHost.host.disconnect()
    if (online === 'true' && !fakeHost.isOnline) await fakeHost.host.connect()
    if (online) fakeHost.isOnline = online === 'true'
    return context.json({ id: fakeHost.host.id, conversations: fakeHost.relay.created })
  })
  .post('/test/fake-machine', async (context) => {
    const { db = '', owner, signedIn, online, drop } = context.req.query()
    if (owner) {
      await fakeMachineByDatabase.get(db)?.host.disconnect()
      await fakeMachineByDatabase.get(db)?.relay.stop()
      const relay = createHqAgentRelay({ gapMilliseconds: stubGapMilliseconds, holdUrl: holdUrlOf(db) })
      const host = await createFakeHosts({ port, database: databaseByName(db) }).fakeHost('My machine', {
        memoryGibibytes: 16,
        containerAgent: relay.containerAgent,
        boot: bootOf(db),
        ownerId: owner,
        signedIn: (signedIn ?? '').split(',').filter(Boolean),
      })
      fakeMachineByDatabase.set(db, { host, relay })
    }
    const machine = fakeMachineByDatabase.get(db)
    if (!owner && signedIn !== undefined && machine) {
      machine.host.signIn(signedIn.split(',').filter(Boolean))
      await machine.host.disconnect()
      await machine.host.connect()
    }
    if (online === 'false') await machine?.host.disconnect()
    if (online === 'true') await machine?.host.connect()
    if (drop === 'true') machine?.relay.dropSockets()
    return context.json({
      id: machine?.host.id,
      conversations: machine?.relay.created ?? [],
      prompts: machine?.relay.prompts ?? [],
      modelSwitches: machine?.relay.modelSwitches ?? [],
      socketPaths: machine?.relay.socketPaths ?? [],
    })
  })
  .post('/test/runtime', async (context) => {
    const { db = '', chat = '', stop } = context.req.query()
    const target = { workspaceId: acme, chatId: chatId(chat), now: Date.now() }
    await zeroDrizzle(schema, databaseByName(db)).transaction(async (tx) => {
      const transactor = createRuntimeTransactor(tx)
      if (stop === 'true') return stopChatRuntime({ transactor }, target)
      await ensureRuntimeRunning({ transactor, ...placement }, { ...target, id: crypto.randomUUID() })
    })
    return context.body(null, 204)
  })
  .post('/test/tool-servers', async (context) => {
    for (const name of testToolServers)
      await llmGateway.setUpToolServer({ name, url: `http://host.docker.internal:${fakeMcpPort}/mcp` })
    await llmGateway.setUpToolServer({
      name: sharedToolServer,
      url: `http://host.docker.internal:${fakeMcpPort}/shared/mcp`,
      isShared: true,
    })
    return context.body(null, 204)
  })
  .get('/test/github-app', (context) =>
    context.json({
      appId: fakeGitHubAppId,
      clientId: fakeGitHubClientId,
      clientSecret: fakeGitHubClientSecret,
      privateKey: fakeGitHub.appPrivateKey,
    }),
  )
  .get('/test/github', async (context) => {
    const { db = '', repository = '', branch = '' } = context.req.query()
    const connections = await databaseByName(db).$client<{ userId: string; sealedToken: string }[]>`
      select user_id as "userId", encrypted_access_token as "sealedToken" from github_connections`
    const ownerOfToken = new Map(
      await Promise.all(
        connections.map(async ({ userId, sealedToken }) => [await github.secretBox.open(sealedToken), userId] as const),
      ),
    )
    return context.json({
      commits: fakeGitHub.commitSubjectsOf(repository, branch),
      headSha: fakeGitHub.branchHeadOf(repository, branch),
      pullRequests: fakeGitHub.pullRequests
        .filter((pullRequest) => pullRequest.repository === repository && pullRequest.head === branch)
        .map(({ authorToken, ...pullRequest }) => ({
          ...pullRequest,
          authorId: ownerOfToken.get(authorToken) ?? null,
        })),
    })
  })
  .post('/test/github-commit', async (context) => {
    const { repository, ...commit } = (await context.req.json()) as Parameters<typeof fakeGitHub.commitToBranch>[1] & {
      repository: string
    }
    return context.json({ head: fakeGitHub.commitToBranch(repository, commit) })
  })
  .post('/test/token', async (context) => {
    const { db = '', user = '', workspace = '' } = context.req.query()
    return context.json(await issueTestSession(databaseByName(db), workspace, user, db))
  })

export default { port, hostname: '0.0.0.0', idleTimeout: 0, fetch: app.fetch, websocket }

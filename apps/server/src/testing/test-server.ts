import { zeroDrizzle } from '@rocicorp/zero/server/adapters/drizzle'
import { acme } from '@spyria/db'
import { createDatabase, type Database } from '@spyria/db/postgres'
import { setModelDirectory } from '@spyria/db/server-writes'
import { databaseUrlOf } from '@spyria/db/testing'
import { schema } from '@spyria/db/zero'
import { chatId, workspaceId } from '@spyria/kernel'
import { createLlmGateway } from '@spyria/profile/server'
import {
  createRuntimeTransactor,
  ensureRuntimeRunning,
  type SandboxProvider,
  stopChatRuntime,
} from '@spyria/runtime/server'
import { createBifrostUsageLogs, syncUsageNow } from '@spyria/usage/server'
import { setCookie } from 'hono/cookie'
import { createAgentBridge } from '../agent-bridge/bridge.ts'
import { createApp, sessionClassifierOf } from '../app.ts'
import { sessionCookieOptions, setSessionCookie, testCookie } from '../auth/routes.ts'
import { createSecretBox } from '../auth/secret-box.ts'
import { openSessions } from '../auth/sessions.ts'
import { createGitHubCheckouts } from '../github/github.ts'
import { createGitHubApi } from '../github/github-api.ts'
import { startJobWorker } from '../job-worker.ts'
import { createModelCallRelay } from '../llm-relay.ts'
import { createRateLimiter, RateLimited } from '../rate-limits.ts'
import { createRuntimeHostGateway, serverWebSocket } from '../runtime-hosts/gateway.ts'
import { readSpyriaAgentImage } from '../spyria-agent-image.ts'
import { startTelemetry } from '../telemetry.ts'
import { fakeGitHubAppId, fakeGitHubClientId, fakeGitHubClientSecret, startFakeGitHub } from './fake-github.ts'
import { createFakeLlm, type FakeLlmScript } from './fake-llm.ts'
import { createFakeMcp, sharedToolServer } from './fake-mcp.ts'
import { createSpyriaAgentRelay } from './spyria-agent-relay.ts'
import {
  createFakeHosts,
  createHolds,
  type FakeHost,
  issueTestSession,
  logInToFakeToolServer,
  testAuthSettings,
  testSecretsKey,
} from './testing.ts'

const port = Number(process.env.PORT ?? 3100)
const fakeMcpPort = Number(process.env.SPYRIA_FAKE_MCP_PORT ?? 3101)
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
const databasesRefusingNextMessage = new Set<string>()
const testRateLimiter = createRateLimiter(testAuthSettings.rateLimits)
const waitForRelease = (databaseName: string, name: string) => holds.wait(`${databaseName}/${name}`)
const fakeHostByDatabase = new Map<
  string,
  { host: FakeHost; relay: ReturnType<typeof createSpyriaAgentRelay>; isOnline: boolean }
>()
const heldInstallByDatabase = new Map<string, () => void>()
const fakeMachineByDatabase = new Map<string, { host: FakeHost; relay: ReturnType<typeof createSpyriaAgentRelay> }>()
const nameOf = (database: Database) =>
  [...servedDatabaseByName].find(([, served]) => served.database === database)?.[0] ?? ''
const gatewaySettings = {
  url: process.env.SPYRIA_GATEWAY_URL ?? '',
  adminUser: process.env.SPYRIA_GATEWAY_ADMIN_USER ?? '',
  adminPassword: process.env.SPYRIA_GATEWAY_ADMIN_PASSWORD ?? '',
}
const llmGateway = createLlmGateway(gatewaySettings)
setModelDirectory(llmGateway.listedModels)
const usageSyncIntervalMilliseconds = 2_000
const stubGapMilliseconds = Number(process.env.SPYRIA_STUB_GAP_MS ?? 20)
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
const apiKeyOfSandbox = (sandbox: string) => {
  const [workspace = '', runtimeId = ''] = sandbox.split('/')
  return runtimeHosts.sandboxProvider.apiKeyOf({ workspaceId: workspaceId(workspace), runtimeId })
}
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
  'x-bf-eh-x-spyria-chat': `${nameOf(database)}/${chat.chatId}`,
  'x-bf-dim-database': nameOf(database),
})
const spyriaAgentImage = (await readSpyriaAgentImage()) ?? `sha256:${'0'.repeat(64)}`
const placement = { spyriaAgentImage }
const runtimeHosts = createRuntimeHostGateway({
  runtimeKeySecret: testAuthSettings.tokenSecret,
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

startTelemetry()
const app = createApp({
  database: createDatabase(databaseUrlOf('postgres')),
  ...testAuthSettings,
  testDatabaseByName: databaseByName,
  rateLimiter: (name, requester) => {
    if (name === 'messages' && databasesRefusingNextMessage.delete(requester.databaseName ?? ''))
      throw new RateLimited(12)
    testRateLimiter(name, requester)
  },
  llmGateway,
  runtimeHosts,
  agentBridge,
  github,
  ...placement,
})
  .route(
    '/fake-llm',
    createFakeLlm(async (request, isClassifier, prompt) => {
      const chatKey = request.headers.get('x-spyria-chat') ?? (await chatKeyOfPrompt(prompt))
      const chatScript = scriptByChat.get(chatKey)
      if (!isClassifier) chatScript?.used.resolve(true)
      const [databaseName = ''] = chatKey.split('/')
      return chatScript && { ...chatScript.script, held: (name: string) => waitForRelease(databaseName, name) }
    }),
  )
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
      databasesRefusingNextMessage.delete(db)
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
  .post('/test/refuse-next-message', (context) => {
    databasesRefusingNextMessage.add(context.req.query('db') ?? '')
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
      const relay = createSpyriaAgentRelay({
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
    if (keepAgentsOf !== undefined)
      await fakeHost.relay.stopAgentsExcept(keepAgentsOf.split(',').filter(Boolean).map(apiKeyOfSandbox))
    if (online === 'false' && fakeHost.isOnline) await fakeHost.host.disconnect()
    if (online === 'true' && !fakeHost.isOnline) await fakeHost.host.connect()
    if (online) fakeHost.isOnline = online === 'true'
    return context.json({ id: fakeHost.host.id, conversations: fakeHost.relay.created })
  })
  .post('/test/fake-machine', async (context) => {
    const { db = '', owner, signedIn, online, drop, installFailure, holdInstall } = context.req.query()
    if (owner) {
      await fakeMachineByDatabase.get(db)?.host.disconnect()
      await fakeMachineByDatabase.get(db)?.relay.stop()
      const relay = createSpyriaAgentRelay({ gapMilliseconds: stubGapMilliseconds, holdUrl: holdUrlOf(db) })
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
    if (installFailure !== undefined) machine?.host.failInstall(installFailure || undefined)
    if (holdInstall === 'true' && machine) heldInstallByDatabase.set(db, machine.host.hold('install'))
    if (holdInstall === 'false') heldInstallByDatabase.get(db)?.()
    return context.json({
      id: machine?.host.id,
      conversations: machine?.relay.created ?? [],
      prompts: machine?.relay.prompts ?? [],
      modelSwitches: machine?.relay.modelSwitches ?? [],
      socketPaths: machine?.relay.socketPaths ?? [],
      installs: machine?.host.commands.filter(({ op }) => op === 'install').length ?? 0,
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
      await llmGateway.setUpToolServer(
        { name, url: `http://host.docker.internal:${fakeMcpPort}/mcp` },
        logInToFakeToolServer(llmGateway),
      )
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

export default { port, hostname: '0.0.0.0', idleTimeout: 0, fetch: app.fetch, websocket: serverWebSocket }

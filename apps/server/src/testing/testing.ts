import { afterAll, afterEach, expect, spyOn } from 'bun:test'
import { createHash } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'
import { conversationMutators } from '@spyria/conversation/server'
import { acme, alice, bob, lee } from '@spyria/db'
import { type Database, events, jobs, resetDatabase } from '@spyria/db/postgres'
import { setModelDirectory } from '@spyria/db/server-writes'
import {
  createTestDatabase,
  prepareSeededGatewayKeys,
  shareTestCrm,
  startTestGateway,
  startZeroCache,
  testGatewayAdmin,
} from '@spyria/db/testing'
import {
  type ChatId,
  type ChatPermission,
  chatId,
  type LogEvent,
  type LogSeverity,
  type MemberId,
  memberId,
  setLogOutput,
  type WorkspaceId,
  workspaceId,
} from '@spyria/kernel'
import { createLlmGateway } from '@spyria/profile/server'
import { runtimeMutators } from '@spyria/runtime/server'
import { workspaceMutators } from '@spyria/workspace/server'
import { Hono } from 'hono'
import { websocket } from 'hono/bun'
import { createAgentBridge } from '../agent-bridge/bridge.ts'
import { createApp, sessionClassifierOf } from '../app.ts'
import { issueSessionToken } from '../auth/session-tokens.ts'
import { openSessions } from '../auth/sessions.ts'
import { createGitHubCheckouts, type GitHubDependencies } from '../github/github.ts'
import { startJobWorker } from '../job-worker.ts'
import { createModelCallRelay } from '../llm-relay.ts'
import { type RateBudgets, rateBudgets } from '../rate-limits.ts'
import { createRuntimeHostGateway } from '../runtime-hosts/gateway.ts'
import { createFakeLlm, type FakeLlmScript, fakeAgentLlm } from './fake-llm.ts'
import { createFakeMcp, sharedToolServer } from './fake-mcp.ts'
import {
  type ContainerAgent,
  createSpyriaAgentRelay,
  type FakeContainer,
  type HostFrame,
  type Launch,
  type ModelCall,
} from './spyria-agent-relay.ts'

export const testSecretsKey = 'e2e-and-integration-test-secrets-key'
const unlimitedRateBudgets = Object.fromEntries(
  Object.entries(rateBudgets).map(([name, budget]) => [name, { ...budget, count: 1_000_000_000 }]),
) as RateBudgets
export const testAuthSettings = {
  rateLimits: unlimitedRateBudgets,
  tokenSecret: 'integration-test-secret',
  appOrigin: 'http://localhost:5190',
  oidc: { issuer: 'http://localhost:5557/dex', clientId: 'spyria', redirectUri: 'http://localhost:3100/auth/callback' },
}

export { acme, alice, bob, globex, lee } from '@spyria/db'
export const aliceInAcme = { workspaceId: acme, userId: alice }
export const bobInAcme = { workspaceId: acme, userId: bob }
export const succeeded = {}
export const failedWith = (message: string) => expect.objectContaining({ error: 'app', message })

export const inviteToAcme = (
  app: Parameters<typeof requestMutation>[0],
  database: Database,
  email: string,
  role = 'member',
) =>
  requestMutation(app, database, aliceInAcme, 'workspace.inviteMember', {
    workspaceId: acme,
    id: crypto.randomUUID(),
    email,
    role,
  })

export const removeFromAcme = (app: Parameters<typeof requestMutation>[0], database: Database, memberId: string) =>
  requestMutation(app, database, aliceInAcme, 'workspace.removeMember', { workspaceId: acme, memberId })

export const workspaceEventsOf = async (database: Database, workspaceId: string = acme) => [
  ...(await database.$client<{ type: string; actorId: string; payload: Record<string, unknown> }[]>`
    select type, actor_id as "actorId", payload from workspace_events where workspace_id = ${workspaceId}
    order by created_at`),
]

export const issueTestSession = async (
  database: Database,
  workspaceId: string,
  userId: string,
  databaseName?: string,
) => {
  const [session] = await openSessions(database, userId, workspaceId)
  if (!session) throw new Error(`${userId} is not a member of ${workspaceId}`)
  const issued = await issueSessionToken(testAuthSettings.tokenSecret, session, { databaseName })
  return { ...issued, sessionId: session.sessionId }
}

export const sessionTokenOf = async (database: Database, workspaceId: string, userId: string) =>
  (await issueTestSession(database, workspaceId, userId)).token

export const waitFor = async (isDone: () => boolean | Promise<boolean>, timeoutMilliseconds = 10_000) => {
  for (const deadline = Date.now() + timeoutMilliseconds; !(await isDone()); await sleep(10))
    if (Date.now() > deadline) throw new Error(`The condition was not met within ${timeoutMilliseconds / 1000} s`)
}

export const createHolds = () => {
  const holdByName = new Map<string, { reached: PromiseWithResolvers<void>; released: PromiseWithResolvers<void> }>()
  const holdOf = (name: string) => {
    const hold = holdByName.get(name) ?? { reached: Promise.withResolvers(), released: Promise.withResolvers() }
    holdByName.set(name, hold)
    return hold
  }
  return {
    wait: (name: string) => {
      const hold = holdOf(name)
      hold.reached.resolve()
      return hold.released.promise
    },
    reached: (name: string) => holdOf(name).reached.promise,
    release: async (name: string) => {
      const hold = holdOf(name)
      await hold.reached.promise
      hold.released.resolve()
    },
    releaseAll: (prefix = '') => {
      for (const [name, hold] of holdByName)
        if (name.startsWith(prefix)) {
          hold.released.resolve()
          holdByName.delete(name)
        }
    },
  }
}

const sharedAppId = 'spyriatest'
const zeroConnectMilliseconds = 30_000

export const requestMutation = async (
  app: { request: (path: string, init: RequestInit) => Response | Promise<Response> },
  database: Database,
  { workspaceId, userId }: { workspaceId: string; userId: string },
  name: string,
  args: Record<string, unknown>,
) => {
  const response = await app.request(`/api/mutate?schema=${sharedAppId}_0&appID=${sharedAppId}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${await sessionTokenOf(database, workspaceId, userId)}` },
    body: JSON.stringify({
      clientGroupID: crypto.randomUUID(),
      mutations: [{ type: 'custom', id: 1, clientID: crypto.randomUUID(), name, args: [args], timestamp: Date.now() }],
      pushVersion: 1,
      timestamp: Date.now(),
      requestID: crypto.randomUUID(),
    }),
  })
  return ((await response.json()) as { mutations: { result: unknown }[] }).mutations[0]?.result
}

const integrationGatewayPort = 4880
const integrationAppPort = 4882
const integrationFakeMcpPort = 4883
export const sharedMcpUrl = `http://host.docker.internal:${integrationFakeMcpPort}/shared/mcp`
export const llmGatewayAt = (url: string) =>
  createLlmGateway({ url, adminUser: testGatewayAdmin.user, adminPassword: testGatewayAdmin.password })

const startSharedTestApp = async () => {
  const testDatabase = await createTestDatabase()
  const { database } = testDatabase
  const fakeLlmCalls: Record<string, string>[] = []
  const fakeLlmBodies: string[] = []
  let fakeLlmScript: FakeLlmScript | undefined
  const holds = createHolds()
  const holdServer = Bun.serve({
    port: 0,
    idleTimeout: 0,
    fetch: async (request) => {
      await holds.wait(new URL(request.url).searchParams.get('name') ?? '')
      return new Response(null, { status: 204 })
    },
  })
  const fakeLlm = new Hono()
    .use(async (context, next) => {
      fakeLlmCalls.push(Object.fromEntries(context.req.raw.headers))
      fakeLlmBodies.push(context.req.method === 'POST' ? await context.req.raw.clone().text() : '')
      await next()
    })
    .route(
      '/',
      createFakeLlm(() => fakeLlmScript && { ...fakeLlmScript, held: holds.wait }),
    )
  const llmGateway = llmGatewayAt(`http://127.0.0.1:${integrationGatewayPort}`)
  setModelDirectory(llmGateway.listedModels)
  const runtimeHosts = createRuntimeHostGateway({
    databases: () => [database],
    relayModelCall: createModelCallRelay({ llmGateway, agentBridge: () => agentBridge }),
  })
  const agentBridge = createAgentBridge({ sandboxProvider: runtimeHosts.sandboxProvider, llm: fakeAgentLlm })
  const app = createApp({ database, ...testAuthSettings, llmGateway, runtimeHosts, agentBridge }).route(
    '/fake-llm',
    fakeLlm,
  )
  const server = Bun.serve({ port: integrationAppPort, fetch: app.fetch, websocket })
  const fakeMcp = createFakeMcp()
  const fakeMcpServer = Bun.serve({ port: integrationFakeMcpPort, fetch: fakeMcp.fetch })
  const stopServerAndDatabase = async () => {
    void server.stop(true)
    void fakeMcpServer.stop(true)
    void holdServer.stop(true)
    await testDatabase.drop()
  }
  const [zeroCache, gateway] = await Promise.allSettled([
    startZeroCache({ databaseName: testDatabase.name, port: 4890, appId: sharedAppId, serverUrl: server.url.origin }),
    startTestGateway({
      name: 'integration',
      port: integrationGatewayPort,
      fakeLlmUrl: `http://host.docker.internal:${server.port}/fake-llm`,
      oauthBase: `http://localhost:${server.port}/gateway-oauth`,
    }),
  ])
  if (zeroCache.status === 'rejected' || gateway.status === 'rejected') {
    if (zeroCache.status === 'fulfilled') await zeroCache.value.stop()
    await stopServerAndDatabase()
    throw zeroCache.status === 'rejected' ? zeroCache.reason : (gateway as PromiseRejectedResult).reason
  }
  await llmGateway.setUpToolServer({ name: 'fake', url: `http://host.docker.internal:${fakeMcpServer.port}/mcp` })
  await llmGateway.setUpToolServer({
    name: sharedToolServer,
    url: `http://host.docker.internal:${fakeMcpServer.port}/shared/mcp`,
    isShared: true,
  })
  const resultOf = (member: { workspaceId: string; userId: string }, name: string, args: Record<string, unknown>) =>
    requestMutation(app, database, member, name, args)
  const eventsOf = async (chatId: string) =>
    (await database.select().from(events))
      .filter((event) => event.chatId === chatId)
      .toSorted((first, second) => first.seq - second.seq)
  const changesOf = async (chatId: string) =>
    (await eventsOf(chatId)).map(({ seq, type, actor, payload }) => ({ seq, type, actor, payload }))
  return {
    database,
    app,
    port: Number(server.port),
    zeroCacheUrl: zeroCache.value.url,
    zeroCacheExited: zeroCache.value.exited,
    gateway: gateway.value,
    llmGateway,
    fakeMcp,
    seededGatewayKeys: () => prepareSeededGatewayKeys(gateway.value),
    fakeLlmCalls,
    fakeLlmBodies,
    holds,
    holdUrl: `http://localhost:${holdServer.port}/hold?`,
    setFakeLlmScript: (script: FakeLlmScript | undefined) => {
      fakeLlmScript = script
    },
    resultOf,
    eventsOf,
    changesOf,
    chatRow: (id: string) => database.query.chats.findFirst({ where: { id } }),
    messagesOf: (chatId: string) => database.query.messages.findMany({ where: { chatId }, orderBy: { seq: 'asc' } }),
    stop: async () => {
      await zeroCache.value.stop()
      await stopServerAndDatabase()
    },
  }
}

let sharedTestApp: ReturnType<typeof startSharedTestApp> | undefined
const openedZeroStores: { close: () => Promise<unknown> }[] = []
const closeZeroStores = () => Promise.all(openedZeroStores.splice(0).map((store) => store.close()))

export const openSharedTestApp = async () => {
  sharedTestApp ??= startSharedTestApp()
  const testApp = await sharedTestApp
  await closeZeroStores()
  testApp.holds.releaseAll()
  const writeSeededGatewayKeys = await testApp.seededGatewayKeys()
  await resetDatabase(testApp.database, async (transaction) => {
    await writeSeededGatewayKeys(transaction)
    await shareTestCrm(transaction)
  })
  if (testApp.llmGateway.listedModels().length === 0) await testApp.llmGateway.refreshListedModels()
  return testApp
}

export const stopSharedTestApp = async () => {
  await closeZeroStores()
  await (await sharedTestApp)?.stop()
}

const openedTestApp = () => sharedTestApp ?? Promise.reject(new Error('Open the shared test app first'))

export const zeroSessionsOf = async (viewerId: string, workspaceIds: readonly string[]) =>
  Promise.all(
    (await openSessions((await openedTestApp()).database, viewerId))
      .filter((session) => workspaceIds.includes(session.workspaceId))
      .map(async (session) => {
        const issued = await issueSessionToken(testAuthSettings.tokenSecret, session)
        return { ...issued, workspaceId: workspaceId(issued.workspaceId) }
      }),
  )

const zeroStoreMutators = { ...workspaceMutators, ...conversationMutators, ...runtimeMutators }
export const openZeroStore = async <Store extends { whenLoaded: (workspace: WorkspaceId) => Promise<unknown> }>(
  createStore: (options: {
    memberId: MemberId
    sessions: Awaited<ReturnType<typeof zeroSessionsOf>>
    renew: (workspace: WorkspaceId) => Promise<Awaited<ReturnType<typeof zeroSessionsOf>>[number] | undefined>
    cacheURL: string
    kvStore: 'mem'
    storageKeyPrefix: string
    mutators: typeof zeroStoreMutators
  }) => Store & { close: () => Promise<unknown> },
  viewerId: string,
  workspaceIds: readonly string[],
) => {
  const store = createStore({
    memberId: memberId(viewerId),
    sessions: await zeroSessionsOf(viewerId, workspaceIds),
    renew: async (workspace) => (await zeroSessionsOf(viewerId, [workspace]))[0],
    cacheURL: (await openedTestApp()).zeroCacheUrl,
    kvStore: 'mem',
    storageKeyPrefix: `${crypto.randomUUID()}:`,
    mutators: zeroStoreMutators,
  })
  openedZeroStores.push(store)
  const timeout = Promise.withResolvers<never>()
  const timer = setTimeout(
    () => timeout.reject(new Error(`The Zero client did not connect within ${zeroConnectMilliseconds / 1000} s`)),
    zeroConnectMilliseconds,
  )
  await Promise.race([
    Promise.all(workspaceIds.map((workspace) => store.whenLoaded(workspaceId(workspace)))),
    (await openedTestApp()).zeroCacheExited.then((reason) => Promise.reject(new Error(reason))),
    timeout.promise,
  ]).finally(() => clearTimeout(timer))
  return store
}

export const captureConsole = () => {
  const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((method) => spyOn(console, method))
  return {
    logged: () => spies.map((spy) => Bun.inspect(spy.mock.calls)).join('\n'),
    restore: () => {
      for (const spy of spies) spy.mockRestore()
    },
  }
}

export const captureLogs = () => {
  const events: (LogEvent & { severity: LogSeverity })[] = []
  setLogOutput((severity, logEvent) => events.push({ severity, ...logEvent }))
  return { events, restore: () => setLogOutput(undefined) }
}

export const everyStoredText = async (database: Database) => {
  const tables = await database.$client<{ name: string }[]>`
    select table_name as name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE'`
  return JSON.stringify(await Promise.all(tables.map(({ name }) => database.$client.unsafe(`select * from "${name}"`))))
}

type GatewayLog = { model: string; metadata: Record<string, string>; selected_key_id: string }
export const gatewayLogsOf = async (
  gateway: { call: <Result>(path: string) => Promise<Result> },
  query: string,
  minimum = 1,
) => {
  const metadataFilters = [...new URLSearchParams(query)].filter(([name]) => name.startsWith('metadata_'))
  let logs: GatewayLog[] = []
  await waitFor(async () => {
    logs = ((await gateway.call<{ logs: GatewayLog[] | null }>(`/api/logs?${query}&limit=100`)).logs ?? []).filter(
      (log) => metadataFilters.every(([name, value]) => log.metadata?.[name.replace('metadata_', '')] === value),
    )
    return logs.length >= minimum
  }, 15_000)
  return logs
}

export const addLlmKey = async (userId: string, provider: string, secret = `fake-key-${crypto.randomUUID()}`) => {
  const { app, database } = await openedTestApp()
  const response = await app.request('/api/llm-credentials', {
    method: 'POST',
    headers: { authorization: `Bearer ${await sessionTokenOf(database, acme, userId)}` },
    body: JSON.stringify({ provider, secret }),
  })
  if (response.status !== 201) throw new Error(`Adding the ${provider} key of ${userId} answered ${response.status}`)
}

export const virtualKeyOf = async (userId: string) => {
  const { database, gateway } = await openedTestApp()
  const [row] = await database.$client`
    select virtual_key_id from member_gateway_keys where workspace_id = ${acme} and user_id = ${userId}`
  return (
    await gateway.call<{
      virtual_key: {
        id: string
        name: string
        value: string
        mcp_configs: { mcp_client: { name: string }; tools_to_execute: string[] }[]
        provider_configs: { keys: { key_id: string }[] }[]
      }
    }>(`/api/governance/virtual-keys/${row?.virtual_key_id}`)
  ).virtual_key
}

export const newChat = async ({
  ownerId = alice,
  type = 'runtime',
  visibility = type === 'runtime' ? 'private' : 'public',
  harness = null,
  id = `chat-${crypto.randomUUID()}`,
  participants = [],
}: {
  ownerId?: string
  type?: 'runtime' | 'channel'
  visibility?: 'public' | 'private'
  harness?: string | null
  id?: string
  participants?: { memberId: string; roleId: string }[]
} = {}) => {
  const { database } = await openedTestApp()
  await database.$client.begin(async (sql) => {
    await sql`
      insert into chats (workspace_id, id, type, visibility, owner_kind, owner_user_id, name, local_session, harness, archived, created_at)
      values (${acme}, ${id}, ${type}, ${visibility}, 'user', ${ownerId}, 'Runtime chat', ${harness !== null}, ${harness}, false, now())`
    for (const { memberId, roleId } of [{ memberId: ownerId, roleId: 'owner' }, ...participants])
      await sql`
        insert into chat_participants (workspace_id, chat_id, user_id, role_id)
        values (${acme}, ${id}, ${memberId}, ${roleId})`
  })
  return chatId(id)
}

const chatAccessRoles = [
  { role: 'outsider', name: 'a non-participant of a private chat', userId: bob, roleId: null, isPublic: false },
  { role: 'reader', name: 'a reader', userId: lee, roleId: 'reader', isPublic: false },
  { role: 'prompter', name: 'a prompter', userId: bob, roleId: 'prompter', isPublic: false },
  { role: 'editor', name: 'an editor', userId: bob, roleId: 'editor', isPublic: false },
  { role: 'owner', name: 'the owner', userId: alice, roleId: 'owner', isPublic: false },
  { role: 'public', name: 'a non-participant of a public channel', userId: lee, roleId: null, isPublic: true },
] as const
type ChatAccessRole = (typeof chatAccessRoles)[number]
export const chatAccessRows = (allowedRoles: readonly ChatAccessRole['role'][]) =>
  chatAccessRoles.map((role) => ({
    ...role,
    member: { workspaceId: acme, userId: role.userId },
    isAllowed: allowedRoles.includes(role.role),
  }))
export const chatAs = (
  role: { isPublic: boolean; roleId: string | null; userId: string },
  type: 'runtime' | 'channel' = 'runtime',
) =>
  newChat({
    type: role.isPublic ? 'channel' : type,
    visibility: role.isPublic ? 'public' : 'private',
    participants: role.roleId && role.roleId !== 'owner' ? [{ memberId: role.userId, roleId: role.roleId }] : [],
  })
export const missingPermission = (permission: ChatPermission) =>
  failedWith(`You need the ${permission} permission on this chat`)
export const posters = ['prompter', 'editor', 'owner', 'public'] as const
export const readers = ['reader', 'prompter', 'editor', 'owner', 'public'] as const
export const addParticipant = async (chatId: string, memberId: string, roleId: string) =>
  (await openedTestApp()).database.$client`
    insert into chat_participants (workspace_id, chat_id, user_id, role_id) values (${acme}, ${chatId}, ${memberId}, ${roleId})`
export const messageRow = async (id: string) =>
  (await openedTestApp()).database.query.messages.findFirst({ where: { id } })
export const jobsOf = async (messageId: string) =>
  (await (await openedTestApp()).database.select().from(jobs)).filter(
    (job) => (job.payload as { messageId: string }).messageId === messageId,
  )
export const countOf = async () => {
  const { database } = await openedTestApp()
  return {
    messages: (await database.query.messages.findMany()).length,
    events: (await database.select().from(events)).length,
    jobs: (await database.select().from(jobs)).length,
    chats: (await database.query.chats.findMany()).length,
  }
}
export const sendTo = async (member: typeof aliceInAcme, chatId: string, id: string, text: string) =>
  (await openedTestApp()).resultOf(member, 'conversation.sendMessage', {
    workspaceId: member.workspaceId,
    id,
    chatId,
    text,
  })
export const writtenMessage = async (chatId: string, authorId: string) => {
  const id = `message-${crypto.randomUUID()}`
  await (await openedTestApp()).database.$client`
    insert into messages (workspace_id, chat_id, id, seq, kind, author_id, body, created_at)
    values (${acme}, ${chatId}, ${id}, 1, 'member', ${authorId}, 'Written before', now())`
  return id
}
export const replyTo = async (
  member: typeof aliceInAcme,
  chatId: string,
  threadRootId: string,
  id = `message-${crypto.randomUUID()}`,
) =>
  (await openedTestApp()).resultOf(member, 'conversation.sendMessage', {
    workspaceId: acme,
    id,
    chatId,
    text: 'In the thread',
    threadRootId,
  })
export const rootIn = async (chatId: string) => {
  const root = `message-${crypto.randomUUID()}`
  await sendTo(aliceInAcme, chatId, root, 'Root')
  return root
}

export const testSpyriaAgentImage = `sha256:${'0'.repeat(64)}`

export const runtimeTurn = async (host: { id: string }, prompterId: string | null, ownerId = alice) => {
  const { database } = await openedTestApp()
  const promptId = `message-${crypto.randomUUID()}`
  const token = `runtime-token-${crypto.randomUUID()}`
  const turnChatId = await newChat({
    ownerId,
    participants: prompterId && prompterId !== ownerId ? [{ memberId: prompterId, roleId: 'prompter' }] : [],
  })
  await database.$client.begin(async (sql) => {
    await sql`
      insert into messages (workspace_id, chat_id, id, seq, kind, author_id, body, created_at)
      values (${acme}, ${turnChatId}, ${promptId}, 1, 'member', ${prompterId ?? ownerId}, 'Go', now())`
    await sql`
      insert into events (workspace_id, chat_id, id, seq, type, actor, payload, created_at)
      values (${acme}, ${turnChatId}, ${promptId}, 1, 'message.posted', ${prompterId ?? ownerId}, '{}', now())`
    await sql`
      insert into runtimes (workspace_id, id, chat_id, host_id, state, host_online, image, llm_token_hash, last_active_at, created_at, state_changed_at)
      values (${acme}, ${crypto.randomUUID()}, ${turnChatId}, ${host.id}, 'running', true, ${testSpyriaAgentImage}, ${sha256(token)}, now(), now(), now())`
    if (prompterId)
      await sql`
        update chats set agent_turn_message_id = ${promptId}, agent_turn_prompter_id = ${prompterId} where id = ${turnChatId}`
  })
  return { chatId: turnChatId, token, promptId }
}

export const startAgentStack = async ({
  routing = false,
  llm,
  now,
  resumeAfterMilliseconds,
  approvalWindowMilliseconds,
  spyriaAgentImage = testSpyriaAgentImage,
  promptsWaitingAfterHello = false,
  github,
  gatewayUrlOf,
}: {
  routing?: boolean
  llm?: Parameters<typeof createAgentBridge>[0]['llm']
  now?: () => number
  resumeAfterMilliseconds?: number
  approvalWindowMilliseconds?: number
  spyriaAgentImage?: string
  promptsWaitingAfterHello?: boolean
  github?: GitHubDependencies
  gatewayUrlOf?: () => string
} = {}) => {
  const testApp = await openSharedTestApp()
  const { database, llmGateway } = testApp
  const runtimeHosts = createRuntimeHostGateway({
    databases: () => [database],
    spyriaAgentImage,
    relayModelCall: routing
      ? createModelCallRelay({ llmGateway, gatewayUrlOf, agentBridge: () => agentBridge })
      : undefined,
    afterHello: promptsWaitingAfterHello
      ? (helloDatabase, host) => agentBridge.forDatabase(helloDatabase).resumeHost(host)
      : undefined,
  })
  const agentBridge = createAgentBridge({
    sandboxProvider: runtimeHosts.sandboxProvider,
    llm,
    now,
    resumeAfterMilliseconds,
    approvalWindowMilliseconds,
    spyriaAgentImage,
    sessionClassifierOf: routing ? sessionClassifierOf(llmGateway, { timeoutMilliseconds: 300 }) : undefined,
    reopenDelayMilliseconds: 50,
    repositoryCheckoutsOf: github && ((checkoutDatabase) => createGitHubCheckouts(checkoutDatabase, github)),
  })
  const app = createApp({
    database,
    ...testAuthSettings,
    llmGateway: routing ? llmGateway : undefined,
    runtimeHosts,
    agentBridge,
    spyriaAgentImage,
    github,
  })
  const server = Bun.serve({ port: 0, fetch: app.fetch, websocket })
  const worker = startJobWorker(database, {
    pollIntervalMilliseconds: 5,
    retryDelayMilliseconds: 100,
    sandboxProvider: runtimeHosts.sandboxProvider,
    agentBridge,
  })
  const { fakeHost, disconnectFakeHosts } = createFakeHosts({ port: Number(server.port), database })
  const browserSockets: WebSocket[] = []
  const relays: ReturnType<typeof createSpyriaAgentRelay>[] = []
  afterEach(async () => {
    for (const socket of browserSockets.splice(0)) socket.close()
    testApp.setFakeLlmScript(undefined)
    testApp.holds.releaseAll()
    await disconnectFakeHosts()
    await Promise.all(relays.splice(0).map((relay) => relay.stop()))
  })
  afterAll(async () => {
    await worker.stop()
    agentBridge.release(database)
    void server.stop(true)
  })
  type Message = Awaited<ReturnType<typeof database.query.messages.findMany>>[number]
  const mutate = (member: { workspaceId: string; userId: string }, name: string, args: Record<string, unknown>) =>
    requestMutation(app, database, member, name, args)
  const turnOf = async (chat: ChatId) =>
    (await database.$client`select agent_turn_message_id from chats where id = ${chat}`)[0]?.agent_turn_message_id
  const repliesTo = async <Field extends keyof Message = 'kind' | 'body'>(
    messageId: string,
    fields = ['kind', 'body'] as Field[],
  ) =>
    (await database.query.messages.findMany({ where: { replyToId: messageId }, orderBy: { seq: 'asc' } })).map(
      (reply) => Object.fromEntries(fields.map((field) => [field, reply[field]])) as Pick<Message, Field>,
    )
  const jobStatesOf = async (type: string, payload: object) =>
    (
      await database.$client<{ state: string }[]>`
        select state from jobs where type = ${type} and payload @> ${JSON.stringify(payload)}::jsonb`
    ).map(({ state }) => state)
  const openStream = async (
    chat: ChatId,
    { workspaceId = acme as string, token }: { workspaceId?: string; token?: string } = {},
  ) => {
    const socket = new WebSocket(`ws://localhost:${server.port}/api/stream`)
    browserSockets.push(socket)
    const frames: string[] = []
    const subscribed = Promise.withResolvers<void>()
    let subscriptions = 0
    const closed = new Promise<void>((resolve) => socket.addEventListener('close', () => resolve()))
    socket.onmessage = (message) => {
      if (!JSON.parse(String(message.data)).subscribed) return frames.push(String(message.data))
      subscriptions += 1
      subscribed.resolve()
    }
    await new Promise((resolve) => socket.addEventListener('open', resolve))
    if (token !== '')
      socket.send(
        JSON.stringify({ type: 'auth', token: token ?? (await sessionTokenOf(database, workspaceId, alice)) }),
      )
    socket.send(JSON.stringify({ type: 'subscribe', chatId: chat }))
    const resubscribe = async () => {
      const before = subscriptions
      socket.send(JSON.stringify({ type: 'unsubscribe', chatId: chat }))
      socket.send(JSON.stringify({ type: 'subscribe', chatId: chat }))
      await waitFor(() => subscriptions > before)
    }
    return { frames, closed, subscribed: subscribed.promise, resubscribe }
  }
  return {
    ...testApp,
    app,
    server,
    runtimeHosts,
    agentBridge,
    worker,
    fakeHost,
    agentHost: async (
      name: string,
      {
        ownerId,
        signedIn,
        relayLimitMilliseconds,
        routesModelCalls = false,
        containerAgentOf = (relay) => relay.containerAgent,
        ...relayOptions
      }: Omit<NonNullable<Parameters<typeof createSpyriaAgentRelay>[0]>, 'modelCall'> & {
        ownerId?: string
        signedIn?: string[]
        relayLimitMilliseconds?: number
        routesModelCalls?: boolean
        containerAgentOf?: (relay: ReturnType<typeof createSpyriaAgentRelay>) => ContainerAgent
      } = {},
    ) => {
      const relay = createSpyriaAgentRelay({
        ...relayOptions,
        modelCall: routesModelCalls ? () => host.modelCall : undefined,
      })
      relays.push(relay)
      const host = await fakeHost(name, {
        containerAgent: containerAgentOf(relay),
        ownerId,
        signedIn,
        relayLimitMilliseconds,
      })
      return { relay, host, launches: () => relay.created as Launch[] }
    },
    mutate,
    newRuntimeChat: newChat,
    prompt: async (chat: ChatId, text: string, member = aliceInAcme) => {
      const id = `message-${crypto.randomUUID()}`
      expect(await mutate(member, 'conversation.sendMessage', { workspaceId: acme, id, chatId: chat, text })).toEqual(
        succeeded,
      )
      return id
    },
    turnOf,
    turnIs: (chat: ChatId, promptId: string | null) => waitFor(async () => (await turnOf(chat)) === promptId, 15_000),
    repliesTo,
    finished: async (promptId: string, chat: ChatId, timeoutMilliseconds?: number) => {
      const replies = () => repliesTo(promptId, ['kind', 'body', 'step'])
      await waitFor(
        async () => (await replies()).some((reply) => reply.body.includes('Hello from the stub')),
        timeoutMilliseconds,
      )
      await waitFor(async () => (await turnOf(chat)) === null, timeoutMilliseconds)
      return replies()
    },
    commandShown: (promptId: string, timeoutMilliseconds?: number) =>
      waitFor(async () => (await repliesTo(promptId)).some((reply) => reply.body === 'command'), timeoutMilliseconds),
    decisionsOf: (chat: ChatId, columns: string[]) =>
      database.$client`
        select ${database.$client(columns)} from routing_decisions
        where workspace_id = ${acme} and chat_id = ${chat} order by created_at`,
    answered: (messageId: string, count = 1) =>
      waitFor(async () => (await repliesTo(messageId)).length >= count, 15_000),
    jobStatesOf,
    jobDone: (type: string, payload: object) =>
      waitFor(async () => {
        const states = await jobStatesOf(type, payload)
        return states.length > 0 && states.every((state) => state === 'done')
      }, 15_000),
    storedAgentEventsOf: async (chat: ChatId) =>
      (await database.select().from(events))
        .filter((event) => event.chatId === chat && event.type === 'agent.event')
        .toSorted((first, second) => first.seq - second.seq),
    runtimeOf: async (chat: ChatId) => {
      const [row] = await database.$client`select * from runtimes where chat_id = ${chat}`
      if (!row) throw new Error(`No runtime for ${chat}`)
      return row
    },
    subscribedFrames: async (chat: ChatId) => {
      const { frames, subscribed } = await openStream(chat)
      await subscribed
      return frames
    },
    openStream,
  }
}

export type { ContainerAgent, FakeContainer, Launch, ModelCall }

const fakeHostGatewayUrl = 'http://fake-gateway-relay.test:4000/v1'
type HostCommand = { op: string; runtimeId?: string; image?: string; apiKey?: string }
export type FakeHost = Awaited<ReturnType<ReturnType<typeof createFakeHosts>['fakeHost']>>

export const asMember = async (userId: string, method: string, path: string, body?: object, workspaceId = acme) => {
  const { app, database } = await openedTestApp()
  const response = await app.request(path, {
    method,
    headers: { authorization: `Bearer ${await sessionTokenOf(database, workspaceId, userId)}` },
    body: body && JSON.stringify(body),
  })
  return { status: response.status, body: await response.text() }
}
export const connectionPath = (action: string) => `/api/tool-connections/fake/${action}`
export const consentThroughSpyria = async (authorizeUrl: string, cookie: string) => {
  const { app } = await openedTestApp()
  const authorized = await fetch(authorizeUrl, { redirect: 'manual', headers: { cookie } })
  const callback = new URL(authorized.headers.get('location') ?? '')
  const page = await app.request(`${callback.pathname}${callback.search}`)
  return { callbackPath: callback.pathname, status: page.status, page: await page.text() }
}
export const connectAlice = async (cookie: string) => {
  const started = await asMember(alice, 'POST', connectionPath('connect'))
  expect(started.status).toBe(200)
  const consent = await consentThroughSpyria(JSON.parse(started.body).authorizeUrl, cookie)
  expect(consent.page).toContain('"connected":true')
  expect(await asMember(alice, 'POST', connectionPath('refresh'))).toEqual({
    status: 200,
    body: JSON.stringify({ status: 'Connected' }),
  })
}
export const connectionRows = async () => [
  ...(await (
    await openedTestApp()
  ).database.$client`
    select user_id, tool, status from tool_connections where tool = 'fake'`),
]
export const rpcOf = (method: string, params: object = {}) => JSON.stringify({ jsonrpc: '2.0', id: 7, method, params })
export const mcpCall = async (
  host: FakeHost,
  token: string,
  body: string,
  headers: Record<string, string> = {},
  signal?: AbortSignal,
) => {
  const answer = await host.modelCall({
    signal,
    path: '/mcp',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...headers,
    },
    body,
  })
  return { status: answer.status, body: answer.body, result: JSON.parse(answer.body || '{}').result }
}
export const whoami = rpcOf('tools/call', { name: 'fake-whoami', arguments: {} })
export const lookup = rpcOf('tools/call', { name: `${sharedToolServer}-lookup`, arguments: {} })
export const textOf = (result: { content?: { text: string }[] }) =>
  result?.content?.map((part) => part.text).join('') ?? ''
export const promptedBy = async (chatId: string, prompterId: string) =>
  (await openedTestApp()).database.$client`update chats set agent_turn_prompter_id = ${prompterId} where id = ${chatId}`
const gibibyte = 1024 ** 3
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex')

export const createFakeHosts = ({ port, database }: { port: number; database: Database }) => {
  const connectedHosts = new Set<FakeHost>()
  const hostStatus = async (hostId: string) =>
    (await database.$client`select status from runtime_hosts where id = ${hostId}`)[0]?.status
  const fakeHost = async (
    name: string,
    {
      memoryGibibytes = 8,
      containerAgent,
      boot = async () => {},
      ownerId,
      signedIn = [],
      relayLimitMilliseconds,
    }: {
      memoryGibibytes?: number
      containerAgent?: ContainerAgent
      boot?: () => Promise<unknown>
      ownerId?: string
      signedIn?: string[]
      relayLimitMilliseconds?: number
    } = {},
  ) => {
    const id = crypto.randomUUID()
    const token = sha256(id)
    let currentSignIns = signedIn
    const credentialsChangedAt = Object.fromEntries(signedIn.map((tool) => [tool, 1]))
    await database.$client`
      insert into runtime_hosts (workspace_id, id, name, token_hash, status, running_runtimes, created_by, owner_id, created_at)
      values (${acme}, ${id}, ${name}, ${sha256(token)}, 'offline', 0, ${ownerId ?? alice}, ${ownerId ?? null}, now())`
    const containers = new Map<string, FakeContainer>()
    const commands: HostCommand[] = []
    const heldReplies = new Map<string, Promise<void>>()
    const failingOps = new Set<string>()
    const installedHarnesses = new Set<string>()
    let installFailure: string | undefined
    const streams = new Map<number, ReturnType<ContainerAgent['connect']>>()
    const modelCalls = new Map<
      number,
      { frames: HostFrame[]; done: () => void; onChunk?: (data: string) => void; onHead?: (status?: number) => void }
    >()
    const receivedFrames: string[] = []
    let nextModelCallId = 1
    const run = (op: string, { runtimeId = '', apiKey = '', harness = '' }: Record<string, string>) => {
      if (failingOps.has(op)) throw new Error(`${op} failed`)
      if (op === 'installed') return installedHarnesses.has(harness)
      if (op === 'install' && installFailure) throw new Error(installFailure)
      if (op === 'install') installedHarnesses.add(harness)
      const container = containers.get(runtimeId)
      if (op === 'create') containers.set(runtimeId, { running: false, apiKey })
      if (op === 'start' && container) {
        Object.assign(container, { running: true, isBooted: false })
        void boot().then(() => {
          container.isBooted = true
        })
      }
      if ((op === 'stop' || op === 'remove') && container) {
        container.running = false
        containerAgent?.stopped?.(container)
      }
      if (op === 'remove') containers.delete(runtimeId)
      if (op === 'status') return container ? (container.running ? 'running' : 'stopped') : 'missing'
      return null
    }
    let socket: WebSocket | undefined
    let closed = Promise.resolve()
    const host = {
      id,
      containers,
      commands,
      failing: (op: string) => failingOps.add(op),
      installedHarnesses,
      failInstall: (reason: string | undefined) => {
        installFailure = reason
      },
      hold: (op: string) => {
        const { promise, resolve } = Promise.withResolvers<void>()
        heldReplies.set(op, promise)
        return resolve
      },
      receivedFrames,
      modelCall: (async ({
        path = '/v1/chat/completions',
        headers = {},
        body = '',
        onChunk,
        onHead,
        signal,
        timeoutMilliseconds = 20_000,
      }) => {
        const sid = nextModelCallId++
        const { promise, resolve } = Promise.withResolvers<void>()
        const frames: HostFrame[] = []
        const cancel = () => {
          socket?.send(JSON.stringify({ type: 'gw_cancel', sid }))
          resolve()
        }
        signal?.addEventListener('abort', cancel)
        modelCalls.set(sid, { frames, done: resolve, onChunk, onHead })
        socket?.send(JSON.stringify({ type: 'gw_req', sid, method: 'POST', path, headers, body }))
        const isAnswered = await Promise.race([
          promise.then(() => true),
          Bun.sleep(timeoutMilliseconds).then(() => false),
        ])
        if (!isAnswered)
          console.error(`A fake host model call to ${path} got no answer within ${timeoutMilliseconds} ms`)
        signal?.removeEventListener('abort', cancel)
        modelCalls.delete(sid)
        const head = frames.find((frame) => frame.type === 'gw_head')
        return {
          status: head?.status,
          body: frames.map((frame) => frame.data ?? '').join(''),
          ended: frames.at(-1)?.type,
        }
      }) satisfies ModelCall,
      lifecycleCommands: () =>
        commands.filter(({ op }) => ['create', 'start', 'stop', 'remove'].includes(op)).map(({ op }) => op),
      closed: () => closed,
      signIn: (tools: string[]) => {
        currentSignIns = tools
        for (const tool of tools) credentialsChangedAt[tool] = (credentialsChangedAt[tool] ?? 0) + 1
      },
      connect: async ({ afterHello }: { afterHello?: () => void } = {}) => {
        const opened = new WebSocket(`ws://localhost:${port}/host`)
        socket = opened
        closed = new Promise((resolve) => opened.addEventListener('close', () => resolve()))
        const send = (frame: object) => opened.send(JSON.stringify(frame))
        opened.onmessage = (message) => {
          receivedFrames.push(String(message.data))
          const frame = JSON.parse(String(message.data)) as HostFrame
          const modelCall = modelCalls.get(frame.sid ?? 0)
          if (modelCall && frame.type.startsWith('gw_')) {
            modelCall.frames.push(frame)
            if (frame.type === 'gw_head') modelCall.onHead?.(frame.status)
            if (frame.type === 'gw_chunk') modelCall.onChunk?.(frame.data ?? '')
            if (frame.type === 'gw_end' || frame.type === 'gw_error') modelCall.done()
            return
          }
          const container = containers.get(frame.runtimeId ?? '')
          if (frame.type === 'ping') send({ type: 'pong' })
          if (frame.type === 'cmd') {
            const op = frame.op ?? ''
            commands.push({ op, ...frame.args })
            const held = heldReplies.get(op)
            heldReplies.delete(op)
            void (held ?? Promise.resolve()).then(() => {
              try {
                send({ type: 'res', id: frame.id, data: run(op, frame.args ?? {}) })
              } catch (error) {
                send({ type: 'res', id: frame.id, error: (error as Error).message })
              }
            })
          }
          if (frame.type === 'http') {
            const isReadyProbe = frame.path === '/ready'
            const isReady = isReadyProbe && container?.running && container.isBooted !== false
            const answered =
              container?.running && !isReadyProbe
                ? Promise.resolve(
                    containerAgent?.respond(frame as Parameters<ContainerAgent['respond']>[0], container),
                  ).catch((error: Error) => ({ error: error.message }))
                : undefined
            const limited =
              relayLimitMilliseconds === undefined
                ? answered
                : Promise.race([
                    answered,
                    Bun.sleep(relayLimitMilliseconds).then(() => ({ error: 'The operation timed out.' })),
                  ])
            void Promise.resolve(limited).then((response) =>
              send({
                type: 'http_res',
                sid: frame.sid,
                status: isReady ? 200 : 503,
                headers: {},
                body: '',
                ...(response as object),
              }),
            )
          }
          const sid = frame.sid ?? 0
          if (frame.type === 'ws_connect' && containerAgent && container?.running) {
            send({ type: 'ws_open', sid })
            streams.set(
              sid,
              containerAgent.connect({
                path: frame.path ?? '',
                container,
                send: (data) => streams.has(sid) && send({ type: 'ws_msg', sid, data }),
                close: () => {
                  if (streams.delete(sid)) send({ type: 'ws_close', sid })
                },
              }),
            )
          } else if (frame.type === 'ws_connect') send({ type: 'ws_close', sid })
          if (frame.type === 'ws_msg') streams.get(sid)?.onMessage(frame.data ?? '')
          if (frame.type === 'ws_close') {
            streams.get(sid)?.onClose()
            streams.delete(sid)
          }
        }
        await new Promise((resolve) => opened.addEventListener('open', resolve))
        send({
          type: 'hello',
          token,
          gatewayUrl: fakeHostGatewayUrl,
          ...(ownerId && { personal: true, signedIn: currentSignIns, credentialsChangedAt }),
          system: {
            cpus: 4,
            memoryBytes: memoryGibibytes * gibibyte,
            dockerVersion: '29.0.0',
            rootless: true,
            cgroupDriver: 'systemd',
            limitsEnforced: true,
          },
        })
        afterHello?.()
        await waitFor(async () => (await hostStatus(id)) === 'online')
        connectedHosts.add(host)
      },
      disconnect: async () => {
        connectedHosts.delete(host)
        for (const stream of streams.values()) stream.onClose()
        streams.clear()
        socket?.close()
        await waitFor(async () => (await hostStatus(id)) !== 'online')
      },
    }
    await host.connect()
    return host
  }
  return {
    fakeHost,
    disconnectFakeHosts: async () => {
      for (const host of connectedHosts) await host.disconnect()
    },
  }
}

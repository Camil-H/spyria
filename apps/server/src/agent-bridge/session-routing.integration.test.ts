import { afterAll, afterEach, expect, setDefaultTimeout, test } from 'bun:test'
import { type ChatId, chatId } from '@hq/kernel'
import { websocket } from 'hono/bun'
import { createApp, sessionClassifierOf } from '../app.ts'
import { startJobWorker } from '../job-worker.ts'
import { createModelCallRelay } from '../llm-relay.ts'
import { createRuntimeHostGateway } from '../runtime-hosts/gateway.ts'
import {
  acme,
  alice,
  aliceInAcme,
  createFakeHosts,
  openSharedTestApp,
  requestMutation,
  bob,
  bobInAcme,
  sessionTokenOf,
  succeeded,
  testAuthSettings,
  waitFor,
} from '../testing.ts'
import { createAgentBridge } from './bridge.ts'
import { createFakeAgentServer } from './fake-agent-server.ts'

setDefaultTimeout(40_000)
const { database, gateway, llmGateway, setFakeLlmScript } = await openSharedTestApp()
const runtimeHosts = createRuntimeHostGateway({
  databases: () => [database],
  relayModelCall: createModelCallRelay({ llmGateway, agentBridge: () => agentBridge }),
})
const agentBridge = createAgentBridge({
  sandboxProvider: runtimeHosts.sandboxProvider,
  sessionClassifierOf: sessionClassifierOf(llmGateway),
})
const app = createApp({ database, ...testAuthSettings, llmGateway, runtimeHosts, agentBridge })
const server = Bun.serve({ port: 0, fetch: app.fetch, websocket })
const worker = startJobWorker(database, {
  pollIntervalMilliseconds: 5,
  retryDelayMilliseconds: 100,
  sandboxProvider: runtimeHosts.sandboxProvider,
  agentBridge,
})
const { fakeHost, disconnectFakeHosts } = createFakeHosts({ port: Number(server.port), database })
afterEach(async () => {
  setFakeLlmScript(undefined)
  await disconnectFakeHosts()
})
afterAll(async () => {
  await worker.stop()
  agentBridge.release(database)
  void server.stop(true)
})

type Route = { tier: string; confidence: string; effort: string } | 'fail' | 'slow'
const routeWith = (route: Route) => setFakeLlmScript({ route })
const fakeAgent = async () => {
  const fake = createFakeAgentServer({ modelCall: () => host.modelCall })
  const host = await fakeHost('Routing host', { agentServer: fake.agentServer })
  return fake
}
type Llm = { model: string; usage_id: string; reasoning_effort?: string }
const llmOf = (conversation: { created: Record<string, unknown> } | undefined) =>
  (conversation?.created.agent as { llm?: Llm } | undefined)?.llm
const newRuntimeChat = async (defaultModel: string | null = 'fake/fake-medium', ownerId = alice) => {
  const id = `chat-${crypto.randomUUID()}`
  await database.$client`
    insert into chats (workspace_id, id, type, owner_kind, owner_user_id, name, default_model, archived, created_at)
    values (${acme}, ${id}, 'runtime', 'user', ${ownerId}, 'Routing chat', ${defaultModel}, false, now())`
  return chatId(id)
}
const prompt = async (chat: ChatId, body: string, member = aliceInAcme) => {
  const id = `message-${crypto.randomUUID()}`
  const sent = await requestMutation(app, database, member, 'conversation.sendMessage', {
    workspaceId: acme,
    id,
    chatId: chat,
    text: body,
  })
  expect(sent).toEqual(succeeded)
  return id
}
const repliesTo = async (messageId: string) =>
  (await database.query.messages.findMany({ where: { replyToId: messageId }, orderBy: { seq: 'asc' } })).map(
    ({ kind, body }) => ({ kind, body }),
  )
const answered = async (messageId: string) => {
  await waitFor(
    async () =>
      (await repliesTo(messageId)).some((reply) => reply.kind === 'agent' || !reply.body.includes('new session')),
    20_000,
  )
  return repliesTo(messageId)
}
const chatOf = async (chat: ChatId) =>
  (
    await database.$client`
      select model, reasoning_effort, default_model, subagent_policy, agent_model from chats where id = ${chat}`
  )[0]
const decisionsOf = async (chat: ChatId) =>
  database.$client`
    select role, model, reason, conversation_id, member_id, classifier_output from routing_decisions
    where workspace_id = ${acme} and chat_id = ${chat} order by created_at`
const gatewayLogsOf = async (chat: ChatId, expectedCount: number) => {
  type Log = { model: string; metadata: Record<string, string> }
  let logs: Log[] = []
  await waitFor(async () => {
    logs = (await gateway.call<{ logs: Log[] | null }>(`/api/logs?metadata_chat=${chat}&limit=100`)).logs ?? []
    return logs.length >= expectedCount
  }, 15_000)
  return logs
}
const routing = (chat: ChatId, member: { workspaceId: string; userId: string }, fields: Record<string, unknown>) =>
  requestMutation(app, database, member, 'conversation.updateChatRouting', {
    workspaceId: acme,
    chatId: chat,
    ...fields,
  })
const addFakeSmallKey = async (userId: string) => {
  const response = await app.request('/api/llm-credentials', {
    method: 'POST',
    headers: { authorization: `Bearer ${await sessionTokenOf(database, acme, userId)}` },
    body: JSON.stringify({ provider: 'Fake-small', secret: `fake-key-${crypto.randomUUID()}` }),
  })
  expect(response.status).toBe(201)
}

test('the first prompt is classified once, on the prompter’s cheapest model with role router, and the session runs on the routed model', async () => {
  const fake = await fakeAgent()
  const chat = await newRuntimeChat()
  routeWith({ tier: 'large', confidence: 'high', effort: 'high' })
  expect(await answered(await prompt(chat, 'Refactor the whole billing architecture'))).toEqual([
    { kind: 'agent', body: 'Understood, working on it.' },
  ])
  const [conversation] = [...fake.conversations.values()]
  expect(conversation?.created.agent).toMatchObject({
    llm: { model: 'openai/fake/fake-large', reasoning_effort: 'high', usage_id: 'agent' },
  })
  expect(await chatOf(chat)).toMatchObject({
    model: 'fake/fake-large',
    reasoning_effort: 'high',
    agent_model: 'fake/fake-large',
  })
  expect([...(await decisionsOf(chat))]).toEqual([
    {
      role: 'session',
      model: 'fake/fake-large',
      reason: 'classified large',
      conversation_id: conversation?.id,
      member_id: alice,
      classifier_output: { tier: 'large', confidence: 'high', effort: 'high', reason: 'fake classification' },
    },
  ])

  routeWith({ tier: 'small', confidence: 'high', effort: 'low' })
  await answered(await prompt(chat, 'And a tiny follow-up'))
  expect(fake.conversations.size).toBe(1)
  expect(await decisionsOf(chat)).toHaveLength(1)
  const logs = await gatewayLogsOf(chat, 3)
  const routerLogs = logs.filter((log) => log.metadata.role === 'router')
  expect(routerLogs).toHaveLength(1)
  expect(routerLogs[0]).toMatchObject({
    model: 'fake-small',
    metadata: { role: 'router', prompter: alice, owner: alice, chat, workspace: acme },
  })
  expect(logs.filter((log) => !log.metadata.role).map((log) => log.model)).toEqual(['fake-large', 'fake-large'])
})

test('a low-confidence, failed or timed-out classification runs the session on the chat default model', async () => {
  const fake = await fakeAgent()
  for (const route of [{ tier: 'large', confidence: 'low', effort: 'medium' }, 'fail', 'slow'] as const) {
    const chat = await newRuntimeChat('fake/fake-small')
    routeWith(route)
    const startedAt = Date.now()
    await answered(await prompt(chat, `Unsure ${JSON.stringify(route)}`))
    if (route === 'slow') expect(Date.now() - startedAt).toBeLessThan(10_000)
    expect(await chatOf(chat)).toMatchObject({ model: 'fake/fake-small' })
    expect((await decisionsOf(chat))[0]).toMatchObject({ role: 'session', model: 'fake/fake-small', reason: 'default' })
  }
  expect(
    [...fake.conversations.values()].map(
      (conversation) => (conversation.created.agent as { llm: { model: string } }).llm.model,
    ),
  ).toEqual(['openai/fake/fake-small', 'openai/fake/fake-small', 'openai/fake/fake-small'])
})

test('a lost conversation is routed again for the new session', async () => {
  const fake = await fakeAgent()
  const chat = await newRuntimeChat()
  routeWith({ tier: 'small', confidence: 'high', effort: 'low' })
  await answered(await prompt(chat, 'First session'))
  fake.conversations.clear()
  routeWith({ tier: 'large', confidence: 'high', effort: 'high' })
  await answered(await prompt(chat, 'After the runtime lost it'))
  expect((await decisionsOf(chat)).map((decision) => decision.model)).toEqual(['fake/fake-small', 'fake/fake-large'])
  expect(await chatOf(chat)).toMatchObject({ model: 'fake/fake-large', agent_model: 'fake/fake-large' })
})

test('the manual switch is refused for an unreachable model, recorded, and applied with a fresh usage_id at the next prompt', async () => {
  const fake = await fakeAgent()
  const chat = await newRuntimeChat()
  routeWith({ tier: 'large', confidence: 'high', effort: 'high' })
  await answered(await prompt(chat, 'Start on large'))

  const refused = await routing(chat, aliceInAcme, { sessionModel: 'anthropic/claude-opus-5-5' })
  expect(JSON.stringify(refused)).toContain('Your keys cannot reach Opus 5.5')
  expect(await chatOf(chat)).toMatchObject({ model: 'fake/fake-large' })

  expect(await routing(chat, aliceInAcme, { sessionModel: 'fake/fake-small' })).toEqual(succeeded)
  expect(await chatOf(chat)).toMatchObject({ model: 'fake/fake-small', agent_model: 'fake/fake-large' })
  expect((await decisionsOf(chat)).at(-1)).toMatchObject({ role: 'manual', model: 'fake/fake-small', member_id: alice })

  expect(await answered(await prompt(chat, 'Now on small'))).toEqual([
    { kind: 'agent', body: 'Understood, working on it.' },
  ])
  const [conversation] = [...fake.conversations.values()]
  const switched = llmOf(conversation)
  expect(switched?.model).toBe('openai/fake/fake-small')
  expect(switched?.usage_id).not.toBe('agent')
  expect(fake.conversations.size).toBe(1)
  expect(await chatOf(chat)).toMatchObject({ agent_model: 'fake/fake-small' })

  expect(await routing(chat, aliceInAcme, { sessionModel: 'fake/fake-large' })).toEqual(succeeded)
  await answered(await prompt(chat, 'Back to large'))
  const switchedBack = llmOf(conversation)
  expect(switchedBack?.model).toBe('openai/fake/fake-large')
  expect([...new Set([switched?.usage_id, switchedBack?.usage_id, 'agent'])]).toHaveLength(3)
  const agentModels = (await gatewayLogsOf(chat, 4)).filter((log) => !log.metadata.role).map((log) => log.model)
  expect(agentModels.toSorted()).toEqual(['fake-large', 'fake-large', 'fake-small'])
})

test('the chat default model and subagent policy are stored per chat', async () => {
  const chat = await newRuntimeChat()
  expect(await routing(chat, aliceInAcme, { defaultModel: 'fake/fake-small', subagentPolicy: 'same_as_main' })).toEqual(
    succeeded,
  )
  expect(await chatOf(chat)).toMatchObject({
    default_model: 'fake/fake-small',
    subagent_policy: 'same_as_main',
    model: null,
  })
  expect(JSON.stringify(await routing(chat, aliceInAcme, { defaultModel: 'nowhere/unknown' }))).toContain('error')
  expect(
    await requestMutation(app, database, aliceInAcme, 'workspace.createChat', {
      workspaceId: acme,
      id: 'chat-routing-created',
      name: 'Created',
      type: 'runtime',
      projectId: null,
    }),
  ).toEqual(succeeded)
  expect(await chatOf(chatId('chat-routing-created'))).toMatchObject({
    default_model: 'fake/fake-medium',
    subagent_policy: 'auto',
    model: null,
    reasoning_effort: null,
  })
})

test('a prompter reaching only a small model routes to it, and is refused in a session on a model his keys cannot reach', async () => {
  const fake = await fakeAgent()
  await addFakeSmallKey(bob)
  const bobChat = await newRuntimeChat('fake/fake-medium', bob)
  routeWith({ tier: 'large', confidence: 'high', effort: 'high' })
  await answered(await prompt(bobChat, 'Big job', bobInAcme))
  expect(await chatOf(bobChat)).toMatchObject({ model: 'fake-small/fake-small' })
  expect(
    [...fake.conversations.values()].map(
      (conversation) => (conversation.created.agent as { llm: { model: string } }).llm.model,
    ),
  ).toEqual(['openai/fake-small/fake-small'])

  const aliceChat = await newRuntimeChat()
  await answered(await prompt(aliceChat, 'Alice starts on large'))
  await routing(aliceChat, aliceInAcme, { sessionModel: 'fake/fake-large' })
  const bobPrompt = await prompt(aliceChat, 'Bob joins', bobInAcme)
  expect(await answered(bobPrompt)).toEqual([
    { kind: 'notice', body: 'Your keys cannot reach Fake large; switch the model or add a key' },
  ])
  expect(fake.prompts.map((sent) => sent.text)).not.toContain('Bob joins')
  expect(JSON.stringify(await routing(aliceChat, bobInAcme, { sessionModel: 'fake/fake-large' }))).toContain(
    'Your keys cannot reach Fake large',
  )
})

test('the routing read lists the member’s reachable models and the models used in the chat from model_calls', async () => {
  const chat = await newRuntimeChat()
  await database.$client`
    insert into model_calls (workspace_id, id, chat_id, prompter_id, owner_id, model, provider, input_tokens, output_tokens, cost_micros, status, called_at)
    values (${acme}, ${crypto.randomUUID()}, ${chat}, ${alice}, ${alice}, 'fake-large', 'fake', 100, 20, 3600, 'success', now() - interval '1 minute'),
           (${acme}, ${crypto.randomUUID()}, ${chat}, ${bob}, ${alice}, 'fake-large', 'fake', 300, 30, 9900, 'success', now() - interval '40 days'),
           (${acme}, ${crypto.randomUUID()}, ${chat}, ${alice}, ${alice}, 'fake-small', 'fake', 400, 50, 2700, 'success', now())`
  const response = await app.request(`/api/chats/${chat}/routing`, {
    headers: { authorization: `Bearer ${await sessionTokenOf(database, acme, alice)}` },
  })
  expect(await response.json()).toEqual({
    reachableModels: ['fake/fake-large', 'fake/fake-medium', 'fake/fake-small'],
    contextTokens: 450,
    modelsUsed: [
      { model: 'fake/fake-large', calls: 2, tokens: 450, costMicros: 13500 },
      { model: 'fake/fake-small', calls: 1, tokens: 450, costMicros: 2700 },
    ],
  })
})

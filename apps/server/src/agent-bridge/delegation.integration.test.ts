import { afterAll, afterEach, expect, setDefaultTimeout, test } from 'bun:test'
import { stillRunningOf, subagentFailureOf, unknownTaskOf } from '@hq/conversation/server'
import { type ChatId, chatId, messageId } from '@hq/kernel'
import { websocket } from 'hono/bun'
import { createApp, sessionClassifierOf } from '../app.ts'
import type { FakeLlmScript } from '../fake-llm.ts'
import { startJobWorker } from '../job-worker.ts'
import { createModelCallRelay } from '../llm-relay.ts'
import { createRuntimeHostGateway } from '../runtime-hosts/gateway.ts'
import {
  acme,
  alice,
  aliceInAcme,
  createFakeHosts,
  type FakeHost,
  openSharedTestApp,
  requestMutation,
  succeeded,
  testAuthSettings,
  waitFor,
} from '../testing.ts'
import { createAgentBridge } from './bridge.ts'
import { type Conversation, createFakeAgentServer } from './fake-agent-server.ts'

setDefaultTimeout(40_000)
const { database, gateway, llmGateway, setFakeLlmScript } = await openSharedTestApp()
const runtimeHosts = createRuntimeHostGateway({
  databases: () => [database],
  relayModelCall: createModelCallRelay({ llmGateway, agentBridge: () => agentBridge }),
})
const agentBridge = createAgentBridge({
  sandboxProvider: runtimeHosts.sandboxProvider,
  sessionClassifierOf: sessionClassifierOf(llmGateway),
  resumeAfterMilliseconds: 4_000,
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

const delegatedTask = { tool: 'delegate', arguments: { task: 'List the files', effort: 'small' } }
const confidentSmall = { tier: 'small', confidence: 'high', effort: 'low' }
const delegatingScript = (script: FakeLlmScript = {}): FakeLlmScript => ({
  steps: [delegatedTask],
  text: 'Main done.',
  delegateRoute: confidentSmall,
  subagents: { 'fake-small': { steps: [{ command: 'echo sub' }], text: 'Sub done.' } },
  ...script,
})
const fakeAgent = async () => {
  const fake = createFakeAgentServer({ modelCall: () => host.modelCall })
  const host = await fakeHost('Delegation host', { agentServer: fake.agentServer })
  return { fake, host }
}
const newRuntimeChat = async () => {
  const id = `chat-${crypto.randomUUID()}`
  await database.$client`
    insert into chats (workspace_id, id, type, owner_kind, owner_user_id, name, default_model, archived, created_at)
    values (${acme}, ${id}, 'runtime', 'user', ${alice}, 'Delegation chat', 'fake/fake-medium', false, now())`
  return chatId(id)
}
const prompt = async (chat: ChatId, text: string) => {
  const id = `message-${crypto.randomUUID()}`
  expect(
    await requestMutation(app, database, aliceInAcme, 'conversation.sendMessage', {
      workspaceId: acme,
      id,
      chatId: chat,
      text,
    }),
  ).toEqual(succeeded)
  return id
}
const promptAndAnswer = async (chat: ChatId, text: string) => {
  const id = await prompt(chat, text)
  await waitFor(async () => (await repliesTo(id)).some((reply) => reply.kind === 'agent'), 20_000)
  await waitFor(
    async () =>
      (await database.$client`select agent_turn_message_id from chats where id = ${chat}`)[0]?.agent_turn_message_id ===
      null,
  )
  return id
}
const repliesTo = (messageId: string) =>
  database.query.messages.findMany({ where: { replyToId: messageId }, orderBy: { seq: 'asc' } })
const delegationsOf = (chat: ChatId) =>
  database.$client`
    select id, conversation_id, action_event_id, model, reason, policy, status, token_hash, finished_at from delegations
    where workspace_id = ${acme} and chat_id = ${chat} order by created_at`
type Llm = { model: string; api_key: string }
const agentOf = (conversation: Conversation | undefined) =>
  conversation?.created.agent as { llm: Llm; mcp_config: Record<string, unknown> }
const conversationsOf = (fake: ReturnType<typeof createFakeAgentServer>) => {
  const conversations = [...fake.conversations.values()]
  return {
    main: conversations.find((conversation) => !conversation.created.parent_conversation_id),
    subs: conversations.filter((conversation) => conversation.created.parent_conversation_id),
  }
}
const completionWith = (host: FakeHost, token: string) =>
  host.modelCall({
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'fake/fake-small', messages: [{ role: 'user', content: 'hi' }] }),
  })
const routerCallWith = (host: FakeHost, token: string) =>
  host.modelCall({
    path: '/mcp/router',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'delegate', arguments: {} } }),
  })
type Log = { model: string; metadata: Record<string, string> }
const delegateLogsOf = async (chat: ChatId) => {
  let logs: Log[] = []
  await waitFor(async () => {
    logs = (
      (await gateway.call<{ logs: Log[] | null }>(`/api/logs?metadata_chat=${chat}&metadata_role=delegate&limit=100`))
        .logs ?? []
    ).filter((log) => log.metadata.role === 'delegate')
    return logs.length >= 2
  }, 15_000)
  return logs
}

test('a delegated task runs in a sub-conversation on the classified model, its events are stored once and in order, and the tool answers with the final response', async () => {
  const { fake, host } = await fakeAgent()
  const chat = await newRuntimeChat()
  setFakeLlmScript(delegatingScript())
  const promptId = await promptAndAnswer(chat, 'Delegate the listing')

  const { main, subs } = conversationsOf(fake)
  const [sub] = subs
  expect(subs).toHaveLength(1)
  expect(sub?.created.parent_conversation_id).toBe(main?.id)
  expect(agentOf(sub).llm.model).toBe('openai/fake/fake-small')
  expect(agentOf(sub).llm.api_key).toStartWith('dl_')
  expect(Object.keys(agentOf(sub).mcp_config)).toEqual(['hq'])
  expect(Object.keys(agentOf(main).mcp_config)).toEqual(['hq', 'router'])

  const [delegation] = await delegationsOf(chat)
  expect(delegation).toMatchObject({
    conversation_id: sub?.id,
    model: 'fake/fake-small',
    reason: 'classified small',
    policy: 'auto',
    status: 'finished',
  })
  expect(delegation?.token_hash).not.toContain(agentOf(sub).llm.api_key)
  expect(delegation?.finished_at).not.toBeNull()

  const stored = await database.$client`
    select id, payload from events where workspace_id = ${acme} and chat_id = ${chat}
      and payload->'delegation'->>'id' = ${delegation?.id} order by seq`
  const emitted = (sub?.events ?? []).filter(
    (event) => !(event.kind === 'ConversationStateUpdateEvent' && event.key === 'full_state'),
  )
  expect(stored.map((row) => row.id)).toEqual(emitted.map((event) => event.id))
  expect(stored[0]?.payload.delegation).toEqual({
    id: delegation?.id,
    model: 'fake/fake-small',
    modelName: 'Fake small',
    task: 'List the files',
  })

  const replies = await repliesTo(promptId)
  const stepDelegation = stored[0]?.payload.delegation
  expect(
    replies.map(({ kind, body, step }) => ({ kind, body, delegation: (step as { delegation?: object })?.delegation })),
  ).toEqual([
    { kind: 'step', body: 'tool', delegation: undefined },
    { kind: 'step', body: 'command', delegation: stepDelegation },
    { kind: 'agent', body: 'Main done.', delegation: undefined },
  ])
  expect(replies[0]?.step).toMatchObject({ name: 'delegate', result: 'Sub done.' })

  for (const log of await delegateLogsOf(chat))
    expect(log).toMatchObject({
      model: 'fake-small',
      metadata: { role: 'delegate', delegation: delegation?.id, prompter: alice, owner: alice },
    })
  expect((await completionWith(host, agentOf(sub).llm.api_key)).status).toBe(401)
})

test('the delegation token works only while its delegation runs and only from its runtime host, and the router refuses it and answers no active turn', async () => {
  const { fake, host } = await fakeAgent()
  const chat = await newRuntimeChat()
  const slowSubagent = { text: 'one two three four five six seven eight', wordDelayMilliseconds: 250 }
  setFakeLlmScript(delegatingScript({ subagents: { 'fake-small': slowSubagent } }))
  const answered = promptAndAnswer(chat, 'Delegate slowly')
  await waitFor(() => conversationsOf(fake).subs.length === 1)
  const subToken = agentOf(conversationsOf(fake).subs[0]).llm.api_key
  const otherHost = await fakeHost('Other host')
  expect((await completionWith(otherHost, subToken)).status).toBe(401)
  expect((await completionWith(host, subToken)).status).toBe(200)
  expect((await routerCallWith(host, subToken)).status).toBe(401)
  await answered

  expect((await completionWith(host, subToken)).status).toBe(401)
  const routerToken = String(
    (agentOf(conversationsOf(fake).main).mcp_config.router as { headers: { Authorization: string } }).headers
      .Authorization,
  ).replace('Bearer ', '')
  const withoutTurn = await routerCallWith(host, routerToken)
  expect(withoutTurn.status).toBe(200)
  expect(JSON.parse(withoutTurn.body).result).toEqual({
    content: [{ type: 'text', text: 'This runtime has no active turn' }],
    isError: true,
  })
})

test('the subagent runs on the session model when the policy is Same as main or the classifier is unsure', async () => {
  const { fake } = await fakeAgent()
  const chat = await newRuntimeChat()
  const onSessionModel = { 'fake-medium': { steps: [{ command: 'echo same' }], text: 'Sub on medium.' } }
  setFakeLlmScript(delegatingScript({ delegateRoute: 'fail', subagents: onSessionModel }))
  await promptAndAnswer(chat, 'Delegate while unsure')
  expect(
    await requestMutation(app, database, aliceInAcme, 'conversation.updateChatRouting', {
      workspaceId: acme,
      chatId: chat,
      subagentPolicy: 'same_as_main',
    }),
  ).toEqual(succeeded)
  setFakeLlmScript(delegatingScript({ subagents: onSessionModel }))
  await promptAndAnswer(chat, 'Delegate on the same model')

  expect(conversationsOf(fake).subs.map((sub) => agentOf(sub).llm.model)).toEqual([
    'openai/fake/fake-medium',
    'openai/fake/fake-medium',
  ])
  expect((await delegationsOf(chat)).map(({ model, reason, policy }) => ({ model, reason, policy }))).toEqual([
    { model: 'fake/fake-medium', reason: 'default', policy: 'auto' },
    { model: 'fake/fake-medium', reason: 'same as main', policy: 'same_as_main' },
  ])
})

const turnFailureOf = async (chat: ChatId) =>
  (await database.$client`select agent_turn_failure from chats where id = ${chat}`)[0]?.agent_turn_failure
const stepsOf = async (promptId: string) =>
  (await repliesTo(promptId)).map((reply) => reply.step as { name?: string; result?: string; isError?: boolean } | null)
const slowWork = {
  steps: [{ command: 'echo started' }],
  text: 'one two three four five six',
  wordDelayMilliseconds: 1_000,
}

test('a model asked by the agent comes before the policy and the classifier', async () => {
  await fakeAgent()
  const chat = await newRuntimeChat()
  const onLarge = { 'fake-large': { steps: [{ command: 'echo large' }], text: 'Sub on large.' } }
  const askingLarge = { ...delegatedTask, arguments: { ...delegatedTask.arguments, model: 'fake-large' } }
  setFakeLlmScript(delegatingScript({ steps: [askingLarge], subagents: onLarge }))
  await promptAndAnswer(chat, 'Delegate on fake-large')
  expect(
    await requestMutation(app, database, aliceInAcme, 'conversation.updateChatRouting', {
      workspaceId: acme,
      chatId: chat,
      subagentPolicy: 'same_as_main',
    }),
  ).toEqual(succeeded)
  setFakeLlmScript(
    delegatingScript({
      steps: [{ ...askingLarge, arguments: { task: 'List', effort: 'small', model: 'large' } }],
      subagents: onLarge,
    }),
  )
  await promptAndAnswer(chat, 'Delegate on a large model')

  expect((await delegationsOf(chat)).map(({ model, reason, policy }) => ({ model, reason, policy }))).toEqual([
    { model: 'fake/fake-large', reason: 'asked', policy: 'auto' },
    { model: 'fake/fake-large', reason: 'asked', policy: 'same_as_main' },
  ])
})

test('a long task answers still running, a resume call returns its result, and another chat or turn cannot resume it', async () => {
  const { fake } = await fakeAgent()
  const chat = await newRuntimeChat()
  const resumeCall = { ...delegatedTask, arguments: { ...delegatedTask.arguments, resume: '$resume' } }
  setFakeLlmScript(delegatingScript({ steps: [delegatedTask, resumeCall], subagents: { 'fake-small': slowWork } }))
  const promptId = await prompt(chat, 'Delegate a long task')
  await waitFor(async () => (await stepsOf(promptId))[0]?.result?.startsWith('Task ') === true, 15_000)
  const [delegation] = await delegationsOf(chat)
  const id = String(delegation?.id)
  expect((await stepsOf(promptId))[0]?.result).toBe(stillRunningOf(id))
  const otherTurn = { promptId: messageId('message-other'), prompterId: alice, ownerId: alice, prompterName: 'Alice' }
  const resumeElsewhere = (otherChat: ChatId) =>
    agentBridge.forDatabase(database).delegate({
      chat: { workspaceId: acme, chatId: otherChat },
      turn: otherTurn,
      toolToken: '',
      task: '',
      effort: 'small',
      resume: id,
    })
  expect(await resumeElsewhere(await newRuntimeChat())).toEqual({ text: unknownTaskOf(id), isError: true })
  expect(await resumeElsewhere(chat)).toEqual({ text: unknownTaskOf(id), isError: true })
  await waitFor(async () => (await repliesTo(promptId)).some((reply) => reply.kind === 'agent'), 20_000)

  expect(conversationsOf(fake).subs).toHaveLength(1)
  expect((await delegationsOf(chat)).map((row) => ({ id: row.id, status: row.status }))).toEqual([
    { id, status: 'finished' },
  ])
  const delegateSteps = (await stepsOf(promptId)).filter((step) => step?.name === 'delegate')
  expect(delegateSteps.map((step) => step?.result)).toEqual([stillRunningOf(id), 'one two three four five six'])
})

test('stopping the turn interrupts the running subagent, marks its delegation stopped, and the next prompt runs', async () => {
  const { fake } = await fakeAgent()
  const chat = await newRuntimeChat()
  setFakeLlmScript(delegatingScript({ subagents: { 'fake-small': slowWork } }))
  const promptId = await prompt(chat, 'Delegate then stop')
  await waitFor(async () => (await repliesTo(promptId)).length >= 2, 15_000)
  expect(
    await requestMutation(app, database, aliceInAcme, 'conversation.stopAgent', { workspaceId: acme, chatId: chat }),
  ).toEqual(succeeded)
  await waitFor(async () => (await delegationsOf(chat))[0]?.status === 'stopped')
  const [sub] = conversationsOf(fake).subs
  await waitFor(() => fake.interrupts.includes(String(sub?.id)))
  expect(sub?.executionStatus).toBe('paused')

  setFakeLlmScript({ text: 'Back to normal.' })
  const nextId = await promptAndAnswer(chat, 'Carry on')
  expect((await repliesTo(nextId)).map(({ kind, body }) => ({ kind, body }))).toEqual([
    { kind: 'agent', body: 'Back to normal.' },
  ])
})

test('a failed subagent answers the tool call with an error in HQ wording and leaves the main turn untouched', async () => {
  await fakeAgent()
  const chat = await newRuntimeChat()
  const failing = { steps: [{ command: 'echo sub' }, { fail: 'Overloaded' }] }
  setFakeLlmScript(delegatingScript({ subagents: { 'fake-small': failing } }))
  const promptId = await promptAndAnswer(chat, 'Delegate a failing task')

  const [delegation] = await delegationsOf(chat)
  expect(delegation?.status).toBe('failed')
  const replies = await repliesTo(promptId)
  const [delegateStep] = await stepsOf(promptId)
  expect(delegateStep).toMatchObject({ name: 'delegate', isError: true })
  expect(delegateStep?.result).toStartWith(subagentFailureOf('Fake small', ''))
  const errorStep = replies.find((reply) => (reply.step as { type?: string } | null)?.type === 'error')
  expect(errorStep?.step).toMatchObject({ delegation: { id: delegation?.id } })
  expect(replies.at(-1)).toMatchObject({ kind: 'agent', body: 'Main done.' })
  expect(replies.filter((reply) => reply.kind === 'notice')).toEqual([])
  expect(await turnFailureOf(chat)).toBeNull()
})

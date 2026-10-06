import { afterAll, afterEach, expect, setDefaultTimeout, spyOn, test } from 'bun:test'
import { rebuildMessages } from '@hq/conversation/server'
import { events } from '@hq/db/postgres'
import { schema } from '@hq/db/zero'
import { type ChatId, chatId } from '@hq/kernel'
import { zeroDrizzle } from '@rocicorp/zero/server/adapters/drizzle'
import { websocket } from 'hono/bun'
import { createApp } from '../app.ts'
import { startJobWorker } from '../job-worker.ts'
import { createRuntimeHostGateway } from '../runtime-hosts/gateway.ts'
import {
  acme,
  alice,
  aliceInAcme,
  createFakeHosts,
  globex,
  openSharedTestApp,
  requestMutation,
  sessionTokenOf,
  succeeded,
  testAuthSettings,
  waitFor,
} from '../testing.ts'
import { createAgentBridge } from './bridge.ts'
import { createFakeAgentServer, replyText, text } from './fake-agent-server.ts'

setDefaultTimeout(30_000)
const llm = { baseUrl: 'http://fake-llm.test/v1', model: 'openai/fake' }
const { database } = await openSharedTestApp()
const gateway = createRuntimeHostGateway({ databases: () => [database] })
const agentBridge = createAgentBridge({ sandboxProvider: gateway.sandboxProvider, llm })
const app = createApp({ database, ...testAuthSettings, runtimeHosts: gateway, agentBridge })
const server = Bun.serve({ port: 0, fetch: app.fetch, websocket })
const worker = startJobWorker(database, {
  pollIntervalMilliseconds: 5,
  retryDelayMilliseconds: 100,
  sandboxProvider: gateway.sandboxProvider,
  agentBridge,
})
const { fakeHost, disconnectFakeHosts } = createFakeHosts({ port: Number(server.port), database })
const browserSockets: WebSocket[] = []
afterEach(async () => {
  for (const socket of browserSockets.splice(0)) socket.close()
  await disconnectFakeHosts()
})
afterAll(async () => {
  await worker.stop()
  agentBridge.release(database)
  void server.stop(true)
})

const agentHost = async () => {
  const fake = createFakeAgentServer()
  return { fake, host: await fakeHost('Agent host', { agentServer: fake.agentServer }) }
}

const newRuntimeChat = async () => {
  const id = `chat-${crypto.randomUUID()}`
  await database.$client`
    insert into chats (workspace_id, id, type, owner_kind, owner_user_id, name, archived, created_at)
    values (${acme}, ${id}, 'runtime', 'user', ${alice}, 'Agent chat', false, now())`
  return chatId(id)
}
const prompt = async (chat: ChatId, body: string) => {
  const id = `message-${crypto.randomUUID()}`
  expect(
    await requestMutation(app, database, aliceInAcme, 'conversation.sendMessage', {
      workspaceId: acme,
      id,
      chatId: chat,
      text: body,
    }),
  ).toEqual(succeeded)
  return id
}
const messagesOf = async (chat: ChatId) =>
  database.query.messages.findMany({ where: { chatId: chat }, orderBy: { seq: 'asc' } })
const storedAgentEventsOf = async (chat: ChatId) =>
  (await database.select().from(events))
    .filter((event) => event.chatId === chat && event.type === 'agent.event')
    .toSorted((first, second) => first.seq - second.seq)
const turnOf = async (chat: ChatId) =>
  (await database.$client`select agent_turn_message_id from chats where id = ${chat}`)[0]?.agent_turn_message_id
const repliesTo = async (messageId: string) =>
  (await database.query.messages.findMany({ where: { replyToId: messageId }, orderBy: { seq: 'asc' } })).map(
    ({ kind, body, detail }) => ({ kind, body, detail }),
  )
const answered = (messageId: string, count = 1) =>
  waitFor(async () => (await repliesTo(messageId)).length >= count, 15_000)
const runtimeOf = async (chat: ChatId) => {
  const [row] = await database.$client`
    select runtimes.*, api_key.value as api_key, llm_token.value as llm_token
    from runtimes
    join placeholder_secrets api_key on api_key.workspace_id = runtimes.workspace_id and api_key.ref = runtimes.api_key_ref
    join placeholder_secrets llm_token on llm_token.workspace_id = runtimes.workspace_id and llm_token.ref = runtimes.llm_token_ref
    where chat_id = ${chat}`
  if (!row) throw new Error(`No runtime for ${chat}`)
  return row
}

test('a prompt starts the runtime, creates one conversation with the runtime LLM token and is answered once', async () => {
  const { fake } = await agentHost()
  const chat = await newRuntimeChat()
  const question = await prompt(chat, 'Find the latest pricing')
  await answered(question)

  const runtime = await runtimeOf(chat)
  expect(runtime).toMatchObject({ state: 'running' })
  expect(runtime.llm_token.length).toBeGreaterThanOrEqual(16)
  expect(runtime.llm_token).not.toBe(runtime.api_key)
  const [conversation] = [...fake.conversations.values()]
  expect(fake.conversations.size).toBe(1)
  expect(runtime.agent_conversation_id).toBe(conversation?.id)
  expect(conversation?.created).toMatchObject({
    agent: {
      kind: 'Agent',
      llm: { model: llm.model, base_url: llm.baseUrl, api_key: runtime.llm_token, stream: true },
      tools: [{ name: 'terminal' }, { name: 'file_editor' }],
    },
    autotitle: false,
  })
  expect(fake.prompts).toEqual([{ conversationId: conversation?.id ?? '', text: 'Find the latest pricing' }])
  expect(fake.connections[0]).toMatchObject({ auth: { type: 'auth', session_api_key: runtime.api_key } })
  await waitFor(async () => (await turnOf(chat)) === null)
  expect(await repliesTo(question)).toEqual([{ kind: 'agent', body: replyText, detail: null }])
})

test('each completed event is stored exactly once by its id, deltas never, and messages and tool calls are projected', async () => {
  const { fake } = await agentHost()
  fake.turn = async (conversation, promptText) => {
    await fake.beginTurn(conversation, promptText)
    const action = fake.emit(
      conversation,
      'ActionEvent',
      { source: 'agent', action: { kind: 'TerminalAction', command: 'echo hello' }, tool_name: 'terminal' },
      2,
    )
    fake.emit(conversation, 'ObservationEvent', {
      source: 'environment',
      action_id: action.id,
      observation: { kind: 'TerminalObservation', content: [{ type: 'text', text: 'hello' }], exit_code: 0 },
    })
    fake.emit(conversation, 'ConversationStateUpdateEvent', { source: 'environment', key: 'stats', value: {} })
    fake.finishTurn(conversation, 3)
  }
  const chat = await newRuntimeChat()
  const question = await prompt(chat, 'Say hello in the terminal')
  await answered(question, 2)
  await waitFor(async () => (await turnOf(chat)) === null)

  const [conversation] = [...fake.conversations.values()]
  const stored = await storedAgentEventsOf(chat)
  expect(stored.map((event) => event.id)).toEqual(conversation?.events.map((event) => event.id) ?? [])
  expect(stored.some((event) => JSON.stringify(event.payload).includes('StreamingDeltaEvent'))).toBe(false)
  expect(stored.some((event) => JSON.stringify(event.payload).includes('full_state'))).toBe(false)
  expect(await repliesTo(question)).toEqual([
    { kind: 'tool-call', body: 'echo hello', detail: 'hello' },
    { kind: 'agent', body: replyText, detail: null },
  ])
  const live = await messagesOf(chat)
  expect(live.map((message) => message.kind)).toEqual(['member', 'tool-call', 'agent'])
  await zeroDrizzle(schema, database).transaction((tx) => rebuildMessages(tx, { chatId: chat }))
  expect(await messagesOf(chat)).toEqual(live)
})

test('a reconnect resumes from the last stored event with resend_mode=since, without duplicates or gaps', async () => {
  const { fake } = await agentHost()
  const chat = await newRuntimeChat()
  fake.turn = async (conversation, promptText) => {
    await fake.beginTurn(conversation, promptText)
    await waitFor(async () => (await storedAgentEventsOf(chat)).length >= 2)
    for (const close of conversation.closers) close()
    fake.emit(conversation, 'ConversationStateUpdateEvent', { source: 'environment', key: 'stats', value: {} })
    fake.emit(conversation, 'MessageEvent', {
      source: 'agent',
      llm_message: { role: 'assistant', content: text('Half way.') },
    })
    await waitFor(() => fake.connections.length >= 2, 5000)
    fake.finishTurn(conversation)
  }
  const question = await prompt(chat, 'Survive a reconnect')
  await answered(question, 2)
  await waitFor(async () => (await turnOf(chat)) === null)

  const [conversation] = [...fake.conversations.values()]
  const stored = await storedAgentEventsOf(chat)
  expect(stored.map((event) => event.id)).toEqual(conversation?.events.map((event) => event.id) ?? [])
  const lastStoredBeforeClose = conversation?.events[1]?.timestamp ?? ''
  const resumed = new URLSearchParams(fake.connections[1]?.query ?? '')
  expect(resumed.get('resend_mode')).toBe('since')
  expect(resumed.get('after_timestamp')).toBe(lastStoredBeforeClose)
  expect((await repliesTo(question)).map((reply) => reply.body)).toEqual(['Half way.', replyText])
})

test('prompts to one chat are delivered one turn at a time, in order, each exactly once, even with two workers', async () => {
  const secondWorker = startJobWorker(database, {
    pollIntervalMilliseconds: 5,
    sandboxProvider: gateway.sandboxProvider,
    agentBridge,
  })
  const { fake } = await agentHost()
  const releases: (() => void)[] = []
  fake.turn = async (conversation, promptText) => {
    await fake.beginTurn(conversation, promptText)
    const { promise, resolve } = Promise.withResolvers<void>()
    releases.push(resolve)
    await promise
    fake.finishTurn(conversation)
  }
  const release = async (turn: number) => {
    await waitFor(() => releases.length > turn)
    releases[turn]?.()
  }
  const chat = await newRuntimeChat()
  const first = await prompt(chat, 'First question')
  await waitFor(() => fake.prompts.length === 1)
  const second = await prompt(chat, 'Second question')
  const third = await prompt(chat, 'Third question')
  await Bun.sleep(300)
  expect(fake.prompts.map((delivered) => delivered.text)).toEqual(['First question'])
  expect(await turnOf(chat)).toBe(first)

  await release(0)
  await waitFor(() => fake.prompts.length === 2)
  expect(await turnOf(chat)).toBe(second)
  await release(1)
  await waitFor(() => fake.prompts.length === 3)
  await release(2)
  await answered(third)
  await Bun.sleep(300)
  expect(fake.prompts.map((delivered) => delivered.text)).toEqual([
    'First question',
    'Second question',
    'Third question',
  ])
  for (const question of [first, second, third])
    expect(await repliesTo(question)).toEqual([{ kind: 'agent', body: replyText, detail: null }])
  expect(fake.conversations.size).toBe(1)
  await secondWorker.stop()
})

const openStream = async (workspaceId: string, chat: ChatId, token?: string) => {
  const socket = new WebSocket(`ws://localhost:${server.port}/api/stream`)
  browserSockets.push(socket)
  const frames: string[] = []
  const closed = new Promise<void>((resolve) => socket.addEventListener('close', () => resolve()))
  socket.onmessage = (message) => frames.push(String(message.data))
  await new Promise((resolve) => socket.addEventListener('open', resolve))
  if (token !== '')
    socket.send(JSON.stringify({ type: 'auth', token: token ?? (await sessionTokenOf(database, workspaceId, alice)) }))
  socket.send(JSON.stringify({ type: 'subscribe', chatId: chat }))
  return { frames, closed }
}

test('stream frames reach browsers of the chat workspace only, and no secret reaches a frame or a log', async () => {
  const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((method) => spyOn(console, method))
  try {
    const { fake } = await agentHost()
    const { promise: subscribed, resolve: startTurn } = Promise.withResolvers<void>()
    fake.turn = async (conversation, promptText) => {
      await subscribed
      await fake.beginTurn(conversation, promptText)
      fake.finishTurn(conversation)
    }
    const chat = await newRuntimeChat()
    const acmeViewer = await openStream(acme, chat)
    const globexViewer = await openStream(globex, chat)
    const anonymous = await openStream(acme, chat, '')
    const question = await prompt(chat, 'Stream to my workspace')
    await Bun.sleep(200)
    startTurn()
    await answered(question)

    const deltas = acmeViewer.frames.map((frame) => JSON.parse(frame))
    expect(deltas.every((frame) => frame.chatId === chat && frame.promptId === question)).toBe(true)
    expect(deltas.map((frame) => frame.text).join('')).toBe(replyText)
    expect(globexViewer.frames).toEqual([])
    expect(anonymous.frames).toEqual([])
    await anonymous.closed

    const runtime = await runtimeOf(chat)
    const everyFrame = [...acmeViewer.frames, ...globexViewer.frames].join('\n')
    const logged = spies.map((spy) => Bun.inspect(spy.mock.calls)).join('\n')
    for (const secret of [runtime.api_key, runtime.llm_token, runtime.api_key_ref, runtime.llm_token_ref]) {
      expect(everyFrame).not.toContain(secret)
      expect(logged).not.toContain(secret)
    }
  } finally {
    for (const spy of spies) spy.mockRestore()
  }
})

test('touchRuntime is called on prompts and on agent events', async () => {
  const { fake } = await agentHost()
  const chat = await newRuntimeChat()
  await answered(await prompt(chat, 'Warm up'))
  const idleSince = async () =>
    new Date((await database.$client`select last_active_at from runtimes where chat_id = ${chat}`)[0]?.last_active_at)
  const makeIdle = () =>
    database.$client`update runtimes set last_active_at = now() - interval '2 hours' where chat_id = ${chat}`
  const isFresh = async () => Date.now() - (await idleSince()).getTime() < 60_000

  await makeIdle()
  await answered(await prompt(chat, 'Touch on prompt'))
  expect(await isFresh()).toBe(true)

  await waitFor(async () => (await turnOf(chat)) === null)
  await makeIdle()
  const [conversation] = [...fake.conversations.values()]
  if (conversation)
    fake.emit(conversation, 'ConversationStateUpdateEvent', { source: 'environment', key: 'stats', value: {} })
  await waitFor(isFresh)
})

test('a failed start and a turn error each end with one notice and no endless turn', async () => {
  const { fake, host } = await agentHost()
  fake.turn = async (conversation, promptText) => {
    await fake.beginTurn(conversation, promptText)
    fake.status(conversation, 'error')
  }
  const erroring = await newRuntimeChat()
  const failedTurn = await prompt(erroring, 'Break the turn')
  await answered(failedTurn)
  await waitFor(async () => (await turnOf(erroring)) === null)
  expect(await repliesTo(failedTurn)).toEqual([
    { kind: 'notice', body: 'The agent stopped with an error', detail: null },
  ])

  host.failing('create')
  const unstartable = await newRuntimeChat()
  const neverStarted = await prompt(unstartable, 'Start please')
  await answered(neverStarted)
  expect(await repliesTo(neverStarted)).toEqual([{ kind: 'notice', body: 'The agent could not start', detail: null }])
  expect(await turnOf(unstartable)).toBeNull()
})

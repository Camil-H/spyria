import { afterAll, afterEach, expect, setDefaultTimeout, spyOn, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { commandOutputPathOf, rebuildMessages } from '@hq/conversation/server'
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
  failedWith,
  fakeHostGatewayUrl,
  globex,
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
import { type Conversation, createFakeAgentServer, replyText, text } from './fake-agent-server.ts'

setDefaultTimeout(30_000)
const llm = { model: 'openai/fake/fake-model' }
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
const llmTokenOf = (conversation: Conversation | undefined) =>
  String((conversation?.created.agent as { llm: { api_key: string } } | undefined)?.llm.api_key)
const runtimeOf = async (chat: ChatId) => {
  const [row] = await database.$client`
select * from runtimes where chat_id = ${chat}`
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
  const [conversation] = [...fake.conversations.values()]
  const llmToken = llmTokenOf(conversation)
  expect(llmToken.length).toBeGreaterThanOrEqual(16)
  expect(llmToken).not.toBe(runtime.api_key)
  expect(runtime.llm_token_hash).toBe(createHash('sha256').update(llmToken).digest('hex'))
  expect(fake.conversations.size).toBe(1)
  expect(runtime.agent_conversation_id).toBe(conversation?.id)
  expect(conversation?.created).toMatchObject({
    agent: {
      kind: 'Agent',
      llm: { model: llm.model, base_url: fakeHostGatewayUrl, stream: true, num_retries: 0 },
      tools: [{ name: 'terminal' }, { name: 'file_editor' }, { name: 'task_tracker' }],
    },
    autotitle: false,
  })
  expect(fake.prompts).toEqual([{ conversationId: conversation?.id ?? '', text: 'Find the latest pricing' }])
  expect(fake.connections[0]).toMatchObject({ auth: { type: 'auth', session_api_key: runtime.api_key } })
  await waitFor(async () => (await turnOf(chat)) === null)
  expect(await repliesTo(question)).toEqual([{ kind: 'agent', body: replyText, detail: null }])
})

test('each completed event is stored exactly once by its id, deltas never, and messages and command steps are projected', async () => {
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
    { kind: 'step', body: 'command', detail: null },
    { kind: 'agent', body: replyText, detail: null },
  ])
  const live = await messagesOf(chat)
  expect(live.map((message) => message.kind)).toEqual(['member', 'step', 'agent'])
  expect(live[1]?.step).toMatchObject({ type: 'command', command: 'echo hello', exitCode: 0, output: 'hello' })
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

test('text streamed before a tool call is stored once, and after a reconnect the finish stores only the rest', async () => {
  const { fake } = await agentHost()
  const chat = await newRuntimeChat()
  fake.turn = async (conversation, promptText) => {
    fake.emit(conversation, 'MessageEvent', {
      source: 'user',
      llm_message: { role: 'user', content: text(promptText) },
    })
    fake.status(conversation, 'running')
    await waitFor(async () => (await storedAgentEventsOf(chat)).length >= 2)
    fake.emit(conversation, 'StreamingDeltaEvent', { source: 'agent', content: 'Looking. ' })
    const toolCall = { source: 'agent', tool_call_id: 'toolu_1', title: 'Terminal', tool_kind: 'execute' }
    fake.emit(conversation, 'ACPToolCallEvent', { ...toolCall, status: 'pending', raw_input: {} })
    await waitFor(async () => (await messagesOf(chat)).some((message) => message.body === 'Looking.'))
    for (const close of conversation.closers) close()
    await waitFor(() => fake.connections.length >= 2, 5000)
    fake.emit(conversation, 'ACPToolCallEvent', {
      ...toolCall,
      status: 'completed',
      title: 'ls',
      raw_input: { command: 'ls' },
      raw_output: 'notes.md',
    })
    fake.emit(conversation, 'StreamingDeltaEvent', { source: 'agent', content: 'Done.' })
    fake.emit(conversation, 'ActionEvent', {
      source: 'agent',
      action: { kind: 'FinishAction', message: 'Looking. Done.' },
      tool_name: 'finish',
    })
    fake.status(conversation, 'finished')
  }
  const question = await prompt(chat, 'Stream around a tool call')
  await answered(question, 3)
  await waitFor(async () => (await turnOf(chat)) === null)

  expect((await repliesTo(question)).map((reply) => reply.body)).toEqual(['Looking.', 'command', 'Done.'])
  const [command] = (await messagesOf(chat)).filter((message) => message.kind === 'step')
  expect(command?.step).toMatchObject({ type: 'command', command: 'ls', exitCode: 0, output: 'notes.md' })
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

test('each step is stored once and updated by its observation, a plan replaces the Plan tab rows, and a rebuild matches', async () => {
  const { fake } = await agentHost()
  const chat = await newRuntimeChat()
  const viewer = await openStream(acme, chat)
  const action = (conversation: Conversation, action: object, fields: object = {}) =>
    fake.emit(conversation, 'ActionEvent', { source: 'agent', thought: text(''), action, ...fields }, 2)
  const observe = (conversation: Conversation, actionId: string, observation: object) =>
    fake.emit(conversation, 'ObservationEvent', { source: 'environment', action_id: actionId, observation })
  let failingId = ''
  const planOf = (status: string) => ({
    kind: 'TaskTrackerAction',
    command: 'plan',
    task_list: [{ title: 'Fix totals', notes: '', status }],
  })
  fake.turn = async (conversation, promptText) => {
    fake.emit(conversation, 'MessageEvent', {
      source: 'user',
      llm_message: { role: 'user', content: text(promptText) },
    })
    fake.status(conversation, 'running')
    fake.emit(conversation, 'StreamingDeltaEvent', { source: 'agent', content: '', reasoning_content: 'Weighing it.' })
    action(conversation, { kind: 'ThinkAction', thought: 'Weighing it.' }, { reasoning_content: 'Weighing it.' })
    action(conversation, planOf('todo'))
    const failing = action(conversation, { kind: 'TerminalAction', command: 'bash -c "exit 3"' })
    failingId = failing.id
    observe(conversation, failing.id, {
      kind: 'TerminalObservation',
      content: text('step one\nstep two'),
      exit_code: 3,
    })
    const edit = action(conversation, {
      kind: 'FileEditorAction',
      command: 'str_replace',
      path: '/workspace/project/totals.ts',
    })
    observe(conversation, edit.id, {
      kind: 'FileEditorObservation',
      command: 'str_replace',
      old_content: 'total = 1\n',
      new_content: 'total = 2\ntax = 0.2\n',
    })
    const search = action(
      conversation,
      { kind: 'MCPToolAction', data: { query: 'pricing' } },
      { tool_name: 'web_search', tool_call: { name: 'web_search', arguments: '{"query": "pricing"}' } },
    )
    observe(conversation, search.id, { kind: 'MCPToolObservation', content: text('3 results') })
    fake.emit(conversation, 'AgentErrorEvent', { source: 'agent', error: 'Tool call failed once.' })
    action(conversation, planOf('done'))
    fake.finishTurn(conversation)
  }
  const question = await prompt(chat, 'Fix the totals')
  await waitFor(async () => (await turnOf(chat)) === null && (await repliesTo(question)).length >= 8)

  const live = await messagesOf(chat)
  expect(live.map((message) => (message.kind === 'step' ? message.step?.type : message.kind))).toEqual([
    'member',
    'thought',
    'plan',
    'command',
    'file',
    'tool',
    'error',
    'plan',
    'agent',
  ])
  expect(live.map((message) => message.step)).toMatchObject([
    null,
    { type: 'thought', text: 'Weighing it.' },
    { items: [{ title: 'Fix totals', status: 'todo' }] },
    { command: 'bash -c "exit 3"', exitCode: 3, output: 'step one\nstep two' },
    { operation: 'edit', path: 'totals.ts', added: 2, removed: 1 },
    { name: 'web_search', arguments: '{"query": "pricing"}', result: '3 results' },
    { message: 'Tool call failed once.' },
    { items: [{ title: 'Fix totals', status: 'done' }] },
    null,
  ])
  expect([
    ...(await database.$client`select title, status from plan_steps where chat_id = ${chat} order by position`),
  ]).toEqual([{ title: 'Fix totals', status: 'done' }])
  expect(viewer.frames.map((frame) => JSON.parse(frame))).toContainEqual(
    expect.objectContaining({ promptId: question, text: 'Weighing it.', isReasoning: true }),
  )
  const fullOutputAs = async (workspaceId: string) =>
    (
      await app.request(commandOutputPathOf(chat, failingId), {
        headers: { authorization: `Bearer ${await sessionTokenOf(database, workspaceId, alice)}` },
      })
    ).text()
  expect(await fullOutputAs(acme)).toBe('step one\nstep two')
  expect(await fullOutputAs(globex)).toBe('')
  await zeroDrizzle(schema, database).transaction((tx) => rebuildMessages(tx, { chatId: chat }))
  expect(await messagesOf(chat)).toEqual(live)
})

test('a migrated tool-call row equals the rebuild of its events', async () => {
  const chat = await newRuntimeChat()
  const migrations = new URL('../../../../packages/db/drizzle/', import.meta.url).pathname
  const [migrationPath] = await Array.fromAsync(new Bun.Glob('*_agent_steps/migration.sql').scan(migrations))
  const migration = await Bun.file(`${migrations}${migrationPath}`).text()
  const update = migration.split('--> statement-breakpoint').find((statement) => statement.includes("'tool-call'"))
  const createdAt = '2026-09-30T10:02:00.000Z'
  const legacy = { kind: 'tool-call', body: 'Ran: bun install', detail: 'Done in 35s', replyToId: null }
  await database.$client`
    insert into messages (workspace_id, chat_id, id, seq, kind, body, detail, created_at)
    values (${acme}, ${chat}, 'message-legacy', 1, 'tool-call', ${legacy.body}, ${legacy.detail}, ${createdAt}::timestamptz)`
  await database.$client`
    insert into events (workspace_id, chat_id, id, seq, type, actor, payload, created_at)
    values (${acme}, ${chat}, 'message-legacy', 1, 'message.posted', null, ${JSON.stringify(legacy)}::jsonb, ${createdAt}::timestamptz)`
  await database.$client.unsafe(update ?? 'missing migration')

  const migrated = await messagesOf(chat)
  expect(migrated.map(({ kind, body, step }) => ({ kind, body, step }))).toEqual([
    {
      kind: 'step',
      body: 'Ran: bun install',
      step: {
        type: 'command',
        command: 'Ran: bun install',
        exitCode: null,
        durationMilliseconds: null,
        output: 'Done in 35s',
        truncatedLines: 0,
      },
    },
  ])
  await zeroDrizzle(schema, database).transaction((tx) => rebuildMessages(tx, { chatId: chat }))
  expect(await messagesOf(chat)).toEqual(migrated)
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
    const [conversation] = [...fake.conversations.values()]
    const llmToken = llmTokenOf(conversation)
    const everyFrame = [...acmeViewer.frames, ...globexViewer.frames].join('\n')
    const logged = spies.map((spy) => Bun.inspect(spy.mock.calls)).join('\n')
    for (const secret of [runtime.api_key, llmToken, runtime.llm_token_hash]) {
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

test('a member without an LLM key cannot prompt a runtime chat, and still posts in a channel', async () => {
  const chat = await newRuntimeChat()
  const send = (chatId: string) =>
    requestMutation(app, database, bobInAcme, 'conversation.sendMessage', {
      workspaceId: acme,
      id: `message-${crypto.randomUUID()}`,
      chatId,
      text: 'Bob prompts',
    })
  expect(await send(chat)).toEqual(failedWith('Bob has no LLM key in this workspace'))
  expect(await messagesOf(chat)).toEqual([])
  expect(await send('chat-welcome')).toEqual(succeeded)
})

test('a prompt whose author has no LLM key at turn time ends with HQ’s notice without reaching the agent', async () => {
  const { fake } = await agentHost()
  const chat = await newRuntimeChat()
  const promptId = `message-${crypto.randomUUID()}`
  await database.$client.begin(async (sql) => {
    await sql`
      insert into messages (workspace_id, chat_id, id, seq, kind, author_id, body, created_at)
      values (${acme}, ${chat}, ${promptId}, 1, 'member', ${bob}, 'Prompt after my key was removed', now())`
    await sql`
      insert into events (workspace_id, chat_id, id, seq, type, actor, payload, created_at)
      values (${acme}, ${chat}, ${promptId}, 1, 'message.posted', ${bob}, '{}'::jsonb, now())`
    await sql`
      insert into jobs (workspace_id, id, type, payload, run_at, attempts, state)
      values (${acme}, ${crypto.randomUUID()}, 'agent.prompt', ${JSON.stringify({ messageId: promptId })}::jsonb, now(), 0, 'queued')`
  })
  await answered(promptId)
  expect(await repliesTo(promptId)).toEqual([
    { kind: 'notice', body: 'Bob has no LLM key in this workspace', detail: null },
  ])
  expect(fake.prompts).toEqual([])
  expect(await turnOf(chat)).toBeNull()
})

test('a model error shows the notice recorded by the relay, never the agent’s text, even after the turn ended', async () => {
  const { fake } = await agentHost()
  const chat = await newRuntimeChat()
  fake.turn = async (conversation, promptText) => {
    await fake.beginTurn(conversation, promptText)
    await database.$client`update chats set agent_turn_failure = 'The LLM key of Alice was refused' where id = ${chat}`
    fake.status(conversation, 'error')
    fake.emit(conversation, 'ConversationErrorEvent', {
      source: 'environment',
      code: 'LLMAuthenticationError',
      detail: 'Incorrect API key provided: fak****f00d',
    })
  }
  const question = await prompt(chat, 'Use my key')
  await answered(question, 2)
  const replies = await repliesTo(question)
  expect(replies.map(({ body }) => body)).toContain('The agent stopped with an error')
  expect(JSON.stringify(await messagesOf(chat))).not.toContain('Incorrect API key')
  expect((await messagesOf(chat)).find((message) => message.kind === 'step')?.step).toEqual({
    type: 'error',
    message: 'The LLM key of Alice was refused',
  })
  expect(JSON.stringify(await storedAgentEventsOf(chat))).toContain('Incorrect API key')
})

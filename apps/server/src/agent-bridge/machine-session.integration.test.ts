import { afterAll, afterEach, expect, setDefaultTimeout, test } from 'bun:test'
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
  openSharedTestApp,
  requestMutation,
  sessionTokenOf,
  succeeded,
  testAuthSettings,
  waitFor,
} from '../testing.ts'
import { createAgentBridge } from './bridge.ts'
import { createHqAgentRelay } from './hq-agent-relay.ts'

setDefaultTimeout(40_000)
const { database } = await openSharedTestApp()
const gateway = createRuntimeHostGateway({ databases: () => [database] })
const agentBridge = createAgentBridge({ sandboxProvider: gateway.sandboxProvider, hqAgentForMachines: true })
const app = createApp({ database, ...testAuthSettings, runtimeHosts: gateway, agentBridge })
const server = Bun.serve({ port: 0, fetch: app.fetch, websocket })
const worker = startJobWorker(database, {
  pollIntervalMilliseconds: 5,
  retryDelayMilliseconds: 100,
  sandboxProvider: gateway.sandboxProvider,
  agentBridge,
})
const { fakeHost, disconnectFakeHosts } = createFakeHosts({ port: Number(server.port), database })
const relays: ReturnType<typeof createHqAgentRelay>[] = []
const browserSockets: WebSocket[] = []
afterEach(async () => {
  for (const socket of browserSockets.splice(0)) socket.close()
  await disconnectFakeHosts()
  await database.$client`update runtime_hosts set removed_at = now() where owner_id = ${alice} and removed_at is null`
  await Promise.all(relays.splice(0).map((relay) => relay.stop()))
})
afterAll(async () => {
  await worker.stop()
  agentBridge.release(database)
  void server.stop(true)
})

const machine = async (gapMilliseconds?: number, startFails?: boolean) => {
  const relay = createHqAgentRelay({ gapMilliseconds, startFails })
  relays.push(relay)
  await fakeHost('Machine', { ownerId: alice, signedIn: ['claude'], agentServer: relay.agentServer })
  return relay
}
const newMachineChat = async () => {
  const id = `chat-${crypto.randomUUID()}`
  await database.$client`
    insert into chats (workspace_id, id, type, owner_kind, owner_user_id, name, local_session, harness, archived, created_at)
    values (${acme}, ${id}, 'runtime', 'user', ${alice}, 'Machine chat', true, 'claude-code', false, now())`
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
const turnOf = async (chat: ChatId) =>
  (await database.$client`select agent_turn_message_id from chats where id = ${chat}`)[0]?.agent_turn_message_id
const repliesTo = async (messageId: string) =>
  (await database.query.messages.findMany({ where: { replyToId: messageId }, orderBy: { seq: 'asc' } })).map(
    ({ kind, body, step }) => ({ kind, body, step }),
  )
const finished = async (question: string, chat: ChatId) => {
  await waitFor(async () => (await repliesTo(question)).some((reply) => reply.body.includes('Hello from the stub')))
  await waitFor(async () => (await turnOf(chat)) === null)
  return repliesTo(question)
}
const bodiesOf = (replies: { kind: string; body: string }[]) =>
  replies.map(({ kind, body }) => (kind === 'step' ? body : `${kind}:${body}`))
const storedAgentEventsOf = async (chat: ChatId) =>
  (await database.select().from(events))
    .filter((event) => event.chatId === chat && event.type === 'agent.event')
    .toSorted((first, second) => first.seq - second.seq)
const messagesOf = async (chat: ChatId) =>
  database.query.messages.findMany({ where: { chatId: chat }, orderBy: { seq: 'asc' } })
const openStream = async (chat: ChatId) => {
  const socket = new WebSocket(`ws://localhost:${server.port}/api/stream`)
  browserSockets.push(socket)
  const frames: { text?: string; isReasoning?: boolean; storedId?: string }[] = []
  socket.onmessage = (message) => frames.push(JSON.parse(String(message.data)))
  await new Promise((resolve) => socket.addEventListener('open', resolve))
  socket.send(JSON.stringify({ type: 'auth', token: await sessionTokenOf(database, acme, alice) }))
  socket.send(JSON.stringify({ type: 'subscribe', chatId: chat }))
  await Bun.sleep(200)
  return frames
}
const streamedText = (frames: { text?: string; isReasoning?: boolean }[], isReasoning = false) =>
  frames
    .filter((frame) => frame.text !== undefined && (frame.isReasoning ?? false) === isReasoning)
    .map((frame) => frame.text)
    .join('')
const routingOf = async (chat: ChatId) =>
  (
    (await (
      await app.request(`/api/chats/${chat}/routing`, {
        headers: { authorization: `Bearer ${await sessionTokenOf(database, acme, alice)}` },
      })
    ).json()) as { adapterModels: { currentModelId: string | null; available: { id: string; name: string }[] } }
  ).adapterModels

const toolsReplies = [
  'agent:[t1]',
  'file',
  'agent:permission:allow-always',
  'command',
  'agent:Hello from the stub (model stub-default, mode bypassPermissions).',
]

test('a Claude Code turn on the machine streams text, shows final steps with the diff, ends once and launches with no base URL and no key', async () => {
  const relay = await machine()
  const chat = await newMachineChat()
  const frames = await openStream(chat)
  const question = await prompt(chat, 'stub:tools')
  const replies = await finished(question, chat)

  expect(bodiesOf(replies)).toEqual(toolsReplies)
  expect(replies[1]?.step).toMatchObject({
    type: 'file',
    operation: 'edit',
    path: 'app.ts',
    added: 1,
    removed: 1,
    diff: [
      { kind: 'removed', text: 'one' },
      { kind: 'added', text: 'two' },
    ],
  })
  expect(replies[3]?.step).toMatchObject({ type: 'command', command: 'npm test', exitCode: 1, output: 'exit code 1' })
  expect(replies.filter((reply) => reply.body.includes('Hello from the stub'))).toHaveLength(1)
  expect(streamedText(frames)).toBe(
    '[t1] permission:allow-always Hello from the stub (model stub-default, mode bypassPermissions).',
  )

  const [launch] = relay.created as { agent: Record<string, unknown>; secrets: object }[]
  expect(relay.created).toHaveLength(1)
  expect(launch?.agent).not.toHaveProperty('kind')
  expect(JSON.stringify(launch?.agent.acp_command)).not.toMatch(/BASE_URL|API_KEY/)
  expect(launch?.secrets).toEqual({})

  const environmentQuestion = await prompt(chat, 'stub:env')
  const [, environment] = /env:(\[.*?\])/.exec((await finished(environmentQuestion, chat))[0]?.body ?? '') ?? []
  expect(environment).toBeDefined()
  expect(environment).not.toMatch(/BASE_URL|API_KEY|TOKEN|ANTHROPIC|OPENAI/)

  const live = await messagesOf(chat)
  await zeroDrizzle(schema, database).transaction((tx) => rebuildMessages(tx, { chatId: chat }))
  expect(await messagesOf(chat)).toEqual(live)
})

test('thinking streams as reasoning, then is stored as one thought with its duration', async () => {
  await machine()
  const chat = await newMachineChat()
  const frames = await openStream(chat)
  const replies = await finished(await prompt(chat, 'stub:think'), chat)

  expect(streamedText(frames, true)).toBe('Thinking about the plan.')
  expect(replies).toHaveLength(2)
  expect(replies[0]).toMatchObject({
    kind: 'step',
    step: { type: 'thought', text: 'Thinking about the plan.', durationMilliseconds: expect.any(Number) },
  })
  expect(replies[1]?.kind).toBe('agent')
})

test('Stop closes the turn as stopped, and the next prompt continues the same ACP session', async () => {
  const relay = await machine()
  const chat = await newMachineChat()
  const stopped = await prompt(chat, 'stub:long')
  await waitFor(async () => (await repliesTo(stopped)).some((reply) => reply.body === 'command'))
  expect(
    await requestMutation(app, database, aliceInAcme, 'conversation.stopAgent', { workspaceId: acme, chatId: chat }),
  ).toEqual(succeeded)
  await waitFor(async () => (await turnOf(chat)) === null)
  const stoppedReplies = await repliesTo(stopped)
  expect(stoppedReplies.find((reply) => reply.kind === 'step')?.step).toMatchObject({
    type: 'command',
    command: 'sleep 600',
    exitCode: null,
  })
  expect(stoppedReplies.at(-1)).toMatchObject({ kind: 'notice', body: 'Stopped by Alice' })

  const next = await prompt(chat, 'Carry on')
  const replies = await finished(next, chat)
  expect(replies.at(-1)?.body).toContain('[t2] ')
  expect(bodiesOf(replies).some((body) => body.includes('new session'))).toBe(false)
  expect(relay.created).toHaveLength(1)
  const sessions = (await storedAgentEventsOf(chat)).filter(
    (event) =>
      (event.payload as { event: { update: { sessionUpdate: string } } }).event.update.sessionUpdate ===
      'session_started',
  )
  expect(sessions).toHaveLength(1)
})

test('a socket dropped mid-turn resumes after the last stored seq: no event lost, none stored or streamed twice', async () => {
  const relay = await machine(250)
  const chat = await newMachineChat()
  const frames = await openStream(chat)
  const question = await prompt(chat, 'stub:tools')
  await waitFor(async () => (await repliesTo(question)).some((reply) => reply.body === 'file'))
  relay.dropSockets()
  const replies = await finished(question, chat)

  expect(bodiesOf(replies)).toEqual(toolsReplies)
  expect(relay.socketPaths).toHaveLength(2)
  expect(relay.socketPaths[1]).toMatch(/\?after=[1-9]\d*$/)
  const ids = (await storedAgentEventsOf(chat)).map((event) => event.id)
  expect(new Set(ids).size).toBe(ids.length)
  expect(streamedText(frames)).toBe(
    '[t1] permission:allow-always Hello from the stub (model stub-default, mode bypassPermissions).',
  )
})

test('the adapter’s models list in the routing read, and a pick is switched in place at the next prompt', async () => {
  const relay = await machine()
  const chat = await newMachineChat()
  await finished(await prompt(chat, 'Hello'), chat)
  expect(await routingOf(chat)).toEqual({
    currentModelId: 'stub-default',
    available: [
      { id: 'stub-default', name: 'Default (stub)' },
      { id: 'stub-large', name: 'Large (stub)' },
    ],
  })

  expect(
    await requestMutation(app, database, aliceInAcme, 'conversation.updateChatRouting', {
      workspaceId: acme,
      chatId: chat,
      acpModel: 'stub-large',
    }),
  ).toEqual(succeeded)
  const replies = await finished(await prompt(chat, 'Again'), chat)
  expect(replies.at(-1)?.body).toContain('model stub-large')
  expect(relay.created).toHaveLength(1)
  await waitFor(async () => (await routingOf(chat)).currentModelId === 'stub-large')
})

test('a late chunk of a stopped turn does not land in the next turn', async () => {
  await machine(250)
  const chat = await newMachineChat()
  const frames = await openStream(chat)
  const stopped = await prompt(chat, 'stub:long stub:late')
  await waitFor(async () => (await repliesTo(stopped)).some((reply) => reply.body === 'command'))
  expect(
    await requestMutation(app, database, aliceInAcme, 'conversation.stopAgent', { workspaceId: acme, chatId: chat }),
  ).toEqual(succeeded)
  const next = await prompt(chat, 'stub:tools')
  const replies = await finished(next, chat)

  expect(bodiesOf(replies)).toEqual(toolsReplies.map((body) => body.replace('[t1]', '[t2]')))
  expect(streamedText(frames)).not.toContain('LATE')
  expect((await messagesOf(chat)).some((message) => message.body.includes('LATE'))).toBe(false)
})

test('a start that fails closes the turn at once with the adapter message and does not retry', async () => {
  const relay = await machine(undefined, true)
  const chat = await newMachineChat()
  const question = await prompt(chat, 'Hello')
  await waitFor(async () => (await repliesTo(question)).length > 0)
  await waitFor(async () => (await turnOf(chat)) === null)

  expect(bodiesOf(await repliesTo(question))).toEqual(['notice:The agent could not start: Authentication required'])
  await Bun.sleep(500)
  expect(relay.created).toHaveLength(1)
  expect(await repliesTo(question)).toHaveLength(1)
})

test('a plan update shows as a plan step, and a Task call with its inner calls as one subagent group', async () => {
  await machine()
  const chat = await newMachineChat()
  const planned = await finished(await prompt(chat, 'stub:plan'), chat)
  expect(planned[1]?.step).toEqual({
    type: 'plan',
    items: [
      { title: 'Write tests', status: 'done' },
      { title: 'Fix the bug', status: 'in-progress' },
      { title: 'Ship', status: 'todo' },
    ],
  })

  const replies = await finished(await prompt(chat, 'stub:subagent'), chat)
  const [, host, child] = replies
  expect(host?.step).toMatchObject({ type: 'tool', name: 'Task', result: 'Two files.' })
  expect(child?.step).toMatchObject({
    type: 'command',
    command: 'ls',
    output: 'a.ts',
    delegation: { id: expect.stringMatching(/:task-2$/) },
  })
})

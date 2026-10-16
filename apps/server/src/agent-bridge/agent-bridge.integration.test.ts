import { expect, setDefaultTimeout, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { commandOutputPathOf, rebuildMessages } from '@hq/conversation/server'
import { schema } from '@hq/db/zero'
import { zeroDrizzle } from '@rocicorp/zero/server/adapters/drizzle'
import { startJobWorker } from '../job-worker.ts'
import {
  acme,
  alice,
  captureConsole,
  failedWith,
  globex,
  bob,
  bobInAcme,
  sessionTokenOf,
  startAgentStack,
  succeeded,
  waitFor,
} from '../testing/testing.ts'

setDefaultTimeout(30_000)
const {
  database,
  app,
  runtimeHosts,
  agentBridge,
  mutate,
  newRuntimeChat,
  prompt,
  messagesOf,
  storedAgentEventsOf,
  turnOf,
  runtimeOf,
  openStream,
  holds,
  holdUrl,
  jobDone,
  ...stack
} = await startAgentStack({ llm: { model: 'openai/fake/fake-model' } })
const repliesTo = (messageId: string) => stack.repliesTo(messageId, ['kind', 'body', 'detail'])
const answered = stack.answered
const agentHost = () => stack.agentHost('Agent host', { holdUrl })
const replyOf = (turn: number) => ({
  kind: 'agent' as const,
  body: `[t${turn}] Hello from the stub (model hq/fake/fake-model, mode default).`,
  detail: null,
})
const turnEnded = (chat: string) => waitFor(async () => (await turnOf(chat as never)) === null)

test('a prompt starts the runtime, creates one Pi conversation with the runtime LLM token and is answered once', async () => {
  const { relay, launches } = await agentHost()
  const chat = await newRuntimeChat()
  const question = await prompt(chat, 'Find the latest pricing')
  await answered(question)
  await turnEnded(chat)

  const runtime = await runtimeOf(chat)
  expect(runtime).toMatchObject({ state: 'running' })
  const [launch] = launches()
  expect(launches()).toHaveLength(1)
  const llmToken = String(launch?.secrets.HQ_LLM_TOKEN?.value)
  expect(llmToken.length).toBeGreaterThanOrEqual(16)
  expect(llmToken).not.toBe(runtime.api_key)
  expect(runtime.llm_token_hash).toBe(createHash('sha256').update(llmToken).digest('hex'))
  expect(launch?.agent.acp_model).toBe('hq/fake/fake-model')
  expect(launch?.agent.acp_command.at(-1)).toEndWith('exec pi --mode rpc --no-themes')
  expect(relay.socketPaths).toEqual([`/sockets/events/${runtime.agent_conversation_id}?after=0`])
  expect(relay.prompts).toEqual(['Find the latest pricing'])
  expect(await repliesTo(question)).toEqual([replyOf(1)])
})

test('prompts to one chat are delivered one turn at a time, in order, each exactly once, even with two workers', async () => {
  const secondWorker = startJobWorker(database, {
    pollIntervalMilliseconds: 5,
    sandboxProvider: runtimeHosts.sandboxProvider,
    agentBridge,
  })
  const { relay, launches } = await agentHost()
  const chat = await newRuntimeChat()
  const first = await prompt(chat, 'stub:linger First question')
  await waitFor(() => relay.prompts.length === 1)
  const second = await prompt(chat, 'Second question')
  const third = await prompt(chat, 'Third question')
  for (const waiting of [second, third]) await jobDone('agent.prompt', { messageId: waiting })
  expect(relay.prompts).toEqual(['stub:linger First question'])
  expect(await turnOf(chat)).toBe(first)

  await holds.release('linger')
  await answered(third)
  await turnEnded(chat)
  expect(relay.prompts).toEqual(['stub:linger First question', 'Second question', 'Third question'])
  for (const [index, question] of [first, second, third].entries())
    expect(await repliesTo(question)).toEqual([replyOf(index + 1)])
  expect(launches()).toHaveLength(1)
  await secondWorker.stop()
})

test('each step is stored once and updated by its final call, the full command output stays in its workspace, and a rebuild matches', async () => {
  await agentHost()
  const chat = await newRuntimeChat()
  const viewer = await openStream(chat)
  await viewer.subscribed
  const question = await prompt(chat, 'stub:think stub:tools stub:terminal')
  await answered(question)
  await turnEnded(chat)

  const live = await messagesOf(chat)
  const steps = live.filter((message) => message.kind === 'step').map((message) => message.step)
  expect(steps).toMatchObject([
    { type: 'thought', text: 'Thinking about the plan.' },
    { type: 'file', operation: 'edit', path: 'app.ts', added: 1, removed: 1 },
    { type: 'command', command: 'npm test', exitCode: 1, output: 'exit code 1' },
    { type: 'command', command: 'npm test', exitCode: 2, output: 'one\ntwo\nfailed' },
  ])
  expect(live.at(-1)).toMatchObject({ kind: 'agent', body: expect.stringContaining('Hello from the stub') })
  const stored = await storedAgentEventsOf(chat)
  expect(new Set(stored.map((event) => event.id)).size).toBe(stored.length)
  expect(viewer.frames.map((frame) => JSON.parse(frame))).toContainEqual(
    expect.objectContaining({ promptId: question, text: 'Thinking ', isReasoning: true }),
  )
  const terminal = live.findLast((message) => message.kind === 'step' && message.step?.type === 'command')
  const fullOutputAs = async (workspaceId: string) =>
    (
      await app.request(commandOutputPathOf(chat, String(terminal?.id)), {
        headers: { authorization: `Bearer ${await sessionTokenOf(database, workspaceId, alice)}` },
      })
    ).text()
  expect(await fullOutputAs(acme)).toBe('one\ntwo\nfailed')
  expect(await fullOutputAs(globex)).toBe('')
  await zeroDrizzle(schema, database).transaction((tx) => rebuildMessages(tx, { chatId: chat }))
  expect(await messagesOf(chat)).toEqual(live)
})

test('stream frames reach browsers of the chat workspace only, and no secret reaches a frame or a log', async () => {
  const consoleCalls = captureConsole()
  try {
    const { launches } = await agentHost()
    const chat = await newRuntimeChat()
    const acmeViewer = await openStream(chat)
    const globexViewer = await openStream(chat, { workspaceId: globex })
    const anonymous = await openStream(chat, { token: '' })
    await acmeViewer.subscribed
    const question = await prompt(chat, 'Stream to my workspace')
    await answered(question)
    await turnEnded(chat)

    const deltas = acmeViewer.frames.map((frame) => JSON.parse(frame)).filter((frame) => frame.text !== undefined)
    expect(deltas.every((frame) => frame.chatId === chat && frame.promptId === question)).toBe(true)
    expect(deltas.map((frame) => frame.text).join('')).toBe(replyOf(1).body)
    expect(globexViewer.frames).toEqual([])
    expect(anonymous.frames).toEqual([])
    await anonymous.closed

    const runtime = await runtimeOf(chat)
    const llmToken = String(launches()[0]?.secrets.HQ_LLM_TOKEN?.value)
    const everyFrame = [...acmeViewer.frames, ...globexViewer.frames].join('\n')
    const logged = consoleCalls.logged()
    for (const secret of [runtime.api_key, llmToken, runtime.llm_token_hash]) {
      expect(everyFrame).not.toContain(secret)
      expect(logged).not.toContain(secret)
    }
  } finally {
    consoleCalls.restore()
  }
})

test('a browser that leaves and reopens a chat on the same socket gets each streamed word once', async () => {
  await agentHost()
  const chat = await newRuntimeChat()
  const viewer = await openStream(chat)
  await viewer.subscribed
  await viewer.resubscribe()
  await viewer.resubscribe()
  const question = await prompt(chat, 'Stream once')
  await answered(question)
  await turnEnded(chat)

  const texts = viewer.frames.map((frame) => JSON.parse(frame)).flatMap((frame) => frame.text ?? [])
  expect(texts.join('')).toBe(replyOf(1).body)
})

test('the agent’s workspace reaches viewers live when it changes, is resent to a new viewer but not to a closed one, and is never stored', async () => {
  await agentHost()
  const chat = await newRuntimeChat()
  const viewer = await openStream(chat)
  await viewer.subscribed
  for (const text of ['Hello', 'stub:branch feature/bridge']) {
    await answered(await prompt(chat, text))
    await turnEnded(chat)
  }
  const workspacesIn = (frames: string[]) =>
    frames.map((frame) => JSON.parse(frame)).filter((frame) => frame.workspace !== undefined)
  await waitFor(() => workspacesIn(viewer.frames).length === 2)
  const cwd = workspacesIn(viewer.frames)[0]?.workspace.cwd
  const branched = { sessionUpdate: 'workspace', cwd, branch: 'feature/bridge' }
  expect(workspacesIn(viewer.frames)).toEqual([
    { chatId: chat, workspace: { sessionUpdate: 'workspace', cwd } },
    { chatId: chat, workspace: branched },
  ])
  const newViewer = await openStream(chat)
  await waitFor(() => workspacesIn(newViewer.frames).length === 1)
  expect(workspacesIn(newViewer.frames)).toEqual([{ chatId: chat, workspace: branched, isSnapshot: true }])
  const closedViewerFrames: unknown[] = []
  const closedViewer = { readyState: 3, send: (frame: unknown) => closedViewerFrames.push(frame) }
  await agentBridge.forDatabase(database).watch(closedViewer as never, { userId: alice, workspaceId: acme } as never, {
    workspaceId: acme,
    chatId: chat,
  })
  expect(closedViewerFrames).toEqual([])
  const storedUpdates = (await storedAgentEventsOf(chat)).map(
    (event) => (event.payload as { event: { update: { sessionUpdate: string } } }).event.update.sessionUpdate,
  )
  expect(storedUpdates).toContain('turn_end')
  expect(storedUpdates).not.toContain('workspace')
})

test('touchRuntime is called on prompts and on agent events', async () => {
  await agentHost()
  const chat = await newRuntimeChat()
  await answered(await prompt(chat, 'Warm up'))
  await turnEnded(chat)
  const idleSince = async () =>
    new Date((await database.$client`select last_active_at from runtimes where chat_id = ${chat}`)[0]?.last_active_at)
  const makeIdle = () =>
    database.$client`update runtimes set last_active_at = now() - interval '2 hours' where chat_id = ${chat}`
  const isFresh = async () => Date.now() - (await idleSince()).getTime() < 60_000

  await makeIdle()
  const touched = await prompt(chat, 'stub:command stub:linger Touch on prompt, then on events')
  await waitFor(async () => (await repliesTo(touched)).some((reply) => reply.body === 'command'))
  expect(await isFresh()).toBe(true)

  await makeIdle()
  await holds.release('linger')
  await waitFor(isFresh)
  await turnEnded(chat)
})

test('a failed start and a turn error each end with one notice and no endless turn', async () => {
  const { host } = await agentHost()
  const erroring = await newRuntimeChat()
  const failedTurn = await prompt(erroring, 'stub:fail Break the turn')
  await answered(failedTurn, 2)
  await turnEnded(erroring)
  expect(await repliesTo(failedTurn)).toEqual([
    { kind: 'step', body: 'error', detail: null },
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
  const chat = await newRuntimeChat({ participants: [{ memberId: bob, roleId: 'prompter' }] })
  const send = (chatId: string) =>
    mutate(bobInAcme, 'conversation.sendMessage', {
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
  const { relay } = await agentHost()
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
  expect(relay.prompts).toEqual([])
  expect(await turnOf(chat)).toBeNull()
})

test('a model failure recorded by the relay shows as the error at the turn end, after the agent’s text', async () => {
  const { relay } = await agentHost()
  const chat = await newRuntimeChat()
  const question = await prompt(chat, 'stub:slow Use my key')
  await waitFor(() => relay.prompts.length === 1)
  await database.$client`update chats set agent_turn_failure = 'The LLM key of Alice was refused' where id = ${chat}`
  await holds.release('slow')
  await answered(question, 2)
  await turnEnded(chat)
  expect(await repliesTo(question)).toEqual([replyOf(1), { kind: 'step', body: 'error', detail: null }])
  expect((await messagesOf(chat)).find((message) => message.kind === 'step')?.step).toEqual({
    type: 'error',
    message: 'The LLM key of Alice was refused',
  })
})

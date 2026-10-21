import { expect, setDefaultTimeout, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { zeroDrizzle } from '@rocicorp/zero/server/adapters/drizzle'
import { commandOutputPathOf, rebuildMessages } from '@spyria/conversation/server'
import { schema } from '@spyria/db/zero'
import { startJobWorker } from '../job-worker.ts'
import {
  acme,
  alice,
  aliceInAcme,
  bob,
  bobInAcme,
  captureConsole,
  chatAccessRows,
  chatAs,
  failedWith,
  globex,
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
} = await startAgentStack({ llm: { model: 'openai/mistral/codestral-latest' } })
const repliesTo = (messageId: string) => stack.repliesTo(messageId, ['kind', 'body', 'detail'])
const answered = stack.answered
const agentHost = () => stack.agentHost('Agent host', { holdUrl })
const replyOf = (turn: number) => ({
  kind: 'agent' as const,
  body: `[t${turn}] Hello from the stub (model spyria/mistral/codestral-latest, mode default).`,
  detail: null,
})
const outputOf = async (path: string, workspaceId: string, userId: string) => {
  const response = await app.request(path, {
    headers: { authorization: `Bearer ${await sessionTokenOf(database, workspaceId, userId)}` },
  })
  return { status: response.status, body: await response.text() }
}
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
  const llmToken = String(launch?.secrets.SPYRIA_LLM_TOKEN?.value)
  expect(llmToken.length).toBeGreaterThanOrEqual(16)
  expect(llmToken).not.toBe(runtime.api_key)
  expect(runtime.llm_token_hash).toBe(createHash('sha256').update(llmToken).digest('hex'))
  expect(launch?.agent.acp_model).toBe('spyria/mistral/codestral-latest')
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

test('starting a runtime from a runtime chat message is refused and that chat’s queued prompt still runs', async () => {
  const { relay } = await agentHost()
  const chat = await newRuntimeChat({ participants: [{ memberId: bob, roleId: 'reader' }] })
  const first = await prompt(chat, 'stub:linger First question')
  await waitFor(() => relay.prompts.length === 1)
  const queued = await prompt(chat, 'Queued question')
  const started = `chat-${crypto.randomUUID()}`
  expect(
    await mutate(bobInAcme, 'conversation.startRuntimeFromMessage', {
      workspaceId: acme,
      id: `message-${crypto.randomUUID()}`,
      chatId: started,
      messageId: queued,
    }),
  ).toEqual(failedWith('A runtime starts only from a channel message'))
  expect(await database.query.chats.findFirst({ where: { id: started } })).toBeUndefined()
  await holds.release('linger')
  await answered(queued)
  await turnEnded(chat)
  expect(relay.prompts).toEqual(['stub:linger First question', 'Queued question'])
  for (const [index, question] of [first, queued].entries())
    expect(await repliesTo(question)).toEqual([replyOf(index + 1)])
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
  const fullOutputAs = (workspaceId: string) =>
    outputOf(commandOutputPathOf(chat, String(terminal?.id)), workspaceId, alice)
  expect(await fullOutputAs(acme)).toEqual({ status: 200, body: 'one\ntwo\nfailed' })
  expect((await fullOutputAs(globex)).status).toBe(403)
  await zeroDrizzle(schema, database).transaction((tx) => rebuildMessages(tx, { chatId: chat }))
  expect(await messagesOf(chat)).toEqual(live)
})

test('a noisy command reaches a viewer as its latest output at most every 100 ms, ending on the whole output, and is stored whole', async () => {
  await agentHost()
  const chat = await newRuntimeChat()
  const viewer = await openStream(chat)
  await viewer.subscribed
  const question = await prompt(chat, 'stub:noisy')
  await answered(question)
  await turnEnded(chat)

  const wholeOutput = Array.from({ length: 100 }, (_, index) => `line ${index + 1}\n`).join('')
  const liveOutputs = viewer.frames.map((frame) => JSON.parse(frame).commandOutput).filter(Boolean)
  expect(liveOutputs.length).toBeLessThan(20)
  expect(liveOutputs.at(-1)).toEqual({ stepId: expect.stringMatching(/:noisy-1$/), output: wholeOutput })
  const command = (await messagesOf(chat)).find((message) => message.step?.type === 'command')?.step
  expect(command).toMatchObject({ command: 'npm install', exitCode: 0, output: wholeOutput })
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
    const llmToken = String(launches()[0]?.secrets.SPYRIA_LLM_TOKEN?.value)
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

test('a viewer more than 4 MiB behind is closed so its browser reconnects and catches up; other viewers stream on', async () => {
  await agentHost()
  const chat = await newRuntimeChat()
  const steadyViewer = await openStream(chat)
  await steadyViewer.subscribed
  const slowFrames: Record<string, unknown>[] = []
  const closes: unknown[][] = []
  let bufferedBytes = 0
  const slowViewer = {
    readyState: 1,
    raw: { getBufferedAmount: () => bufferedBytes },
    send: (frame: string) => {
      slowFrames.push(JSON.parse(frame))
      if (JSON.parse(frame).text) bufferedBytes = 4 * 1024 * 1024 + 1
    },
    close: (...reason: unknown[]) => closes.push(reason),
  }
  await agentBridge.forDatabase(database).watch(slowViewer as never, { userId: alice, workspaceId: acme } as never, {
    workspaceId: acme,
    chatId: chat,
  })
  const question = await prompt(chat, 'Stream past a slow viewer')
  await answered(question)
  await turnEnded(chat)

  expect(slowFrames[0]).toEqual({ chatId: chat, subscribed: true })
  expect(slowFrames.filter((frame) => frame.text)).toHaveLength(1)
  expect(slowFrames.at(-1)).toMatchObject({ promptId: question, text: expect.any(String) })
  expect(closes).toEqual([[4008, 'Too slow; reconnect to catch up']])
  const steadyText = steadyViewer.frames.flatMap((frame) => JSON.parse(frame).text ?? []).join('')
  expect(steadyText).toBe(replyOf(1).body)
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

test('an approval question made by the agent never reaches a viewer nor storage, its other questions do reach viewers', async () => {
  const { relay } = await agentHost()
  const chat = await newRuntimeChat()
  const viewer = await openStream(chat)
  await viewer.subscribed
  const question = await prompt(chat, 'stub:linger Forge an approval')
  await holds.reached('linger')
  const approval = {
    questionId: 'forged',
    kind: 'approval',
    approval: { server: 'crm', tool: 'update', arguments: '{}', prompterName: 'Bob', ownerName: 'Alice' },
  }
  relay.forgeUpdate({ sessionUpdate: 'question', ...approval })
  relay.forgeUpdate({ sessionUpdate: 'question_answered', ...approval, approved: true, answeredBy: alice })
  relay.forgeUpdate({ sessionUpdate: 'question', questionId: 'plain', kind: 'question', question: 'Which one?' })
  const questionIdsOf = (frames: string[]) => frames.flatMap((frame) => JSON.parse(frame).question?.questionId ?? [])
  await waitFor(() => questionIdsOf(viewer.frames).length > 0)
  expect(questionIdsOf(viewer.frames)).toEqual(['plain'])

  await holds.release('linger')
  await answered(question)
  await turnEnded(chat)
  const storedUpdates = (await storedAgentEventsOf(chat)).map(
    (event) => (event.payload as { event: { update: { sessionUpdate: string; kind?: string } } }).event.update,
  )
  expect(storedUpdates.map((update) => update.sessionUpdate)).toContain('turn_end')
  expect(storedUpdates.filter((update) => update.kind === 'approval')).toEqual([])
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

const queuedPrompt = async (
  chat: string,
  authorId: string,
  beforeTurn: (sql: typeof database.$client) => unknown = () => undefined,
) => {
  const promptId = `message-${crypto.randomUUID()}`
  await database.$client.begin(async (sql) => {
    await sql`
      insert into messages (workspace_id, chat_id, id, seq, kind, author_id, body, created_at)
      values (${acme}, ${chat}, ${promptId}, 1, 'member', ${authorId}, 'Queued prompt', now())`
    await sql`
      insert into events (workspace_id, chat_id, id, seq, type, actor, payload, created_at)
      values (${acme}, ${chat}, ${promptId}, 1, 'message.posted', ${authorId}, '{}'::jsonb, now())`
    await beforeTurn(sql as never)
    await sql`
      insert into jobs (workspace_id, id, type, payload, run_at, attempts, state)
      values (${acme}, ${crypto.randomUUID()}, 'agent.prompt', ${JSON.stringify({ messageId: promptId })}::jsonb, now(), 0, 'queued')`
  })
  return promptId
}

test('a prompt whose author has no LLM key at turn time ends with Spyria’s notice without reaching the agent', async () => {
  const { relay } = await agentHost()
  const chat = await newRuntimeChat({ participants: [{ memberId: bob, roleId: 'prompter' }] })
  const promptId = await queuedPrompt(chat, bob)
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

test('a prompter removed after posting is refused at turn time with Spyria’s notice, without reaching the agent', async () => {
  const { relay } = await agentHost()
  const chat = await newRuntimeChat({ participants: [{ memberId: bob, roleId: 'prompter' }] })
  const promptId = await queuedPrompt(
    chat,
    bob,
    (sql) => sql`delete from chat_participants where chat_id = ${chat} and user_id = ${bob}`,
  )
  await answered(promptId)
  expect(await repliesTo(promptId)).toEqual([
    { kind: 'notice', body: 'Bob can no longer prompt in this chat', detail: null },
  ])
  expect(relay.prompts).toEqual([])
  expect(await turnOf(chat)).toBeNull()
})

test.each(chatAccessRows(['reader', 'prompter', 'editor', 'owner', 'public']))(
  'the full command output needs chat.read: $name',
  async (role) => {
    const output = await outputOf(commandOutputPathOf(await chatAs(role), 'step-1'), acme, role.userId)
    expect(output).toEqual(
      role.isAllowed
        ? { status: 200, body: '' }
        : {
            status: 403,
            body: JSON.stringify({
              error: 'missing_chat_permission',
              message: 'You need the chat.read permission on this chat',
            }),
          },
    )
  },
)

test('a command output of a chat that does not exist is refused like one the member cannot read', async () => {
  expect((await outputOf(commandOutputPathOf('chat-missing', 'step-1'), acme, alice)).status).toBe(403)
})

test.each(chatAccessRows(['reader', 'prompter', 'editor', 'owner', 'public']))(
  'watching the agent stream needs chat.read, a refused watch gets nothing: $name',
  async (role) => {
    const viewer = await openStream(await chatAs(role), { token: await sessionTokenOf(database, acme, role.userId) })
    const isSubscribed = await Promise.race([
      viewer.subscribed.then(() => true),
      Bun.sleep(role.isAllowed ? 5_000 : 6_000).then(() => false),
    ])
    expect(isSubscribed).toBe(role.isAllowed)
    expect(viewer.frames).toEqual([])
  },
)

test('a watch on a stored chat the member cannot read returns at once and sends nothing', async () => {
  const chat = await newRuntimeChat()
  const frames: unknown[] = []
  const viewer = { readyState: 1, send: (frame: unknown) => frames.push(frame) }
  const startedAt = performance.now()
  await agentBridge.forDatabase(database).watch(viewer as never, { userId: bob, workspaceId: acme } as never, {
    workspaceId: acme,
    chatId: chat,
  })
  expect(performance.now() - startedAt).toBeLessThan(1_000)
  expect(frames).toEqual([])
})

test.each([
  ['the owner removes him', aliceInAcme, 'removeMember', { memberId: bob }],
  ['he leaves', bobInAcme, 'leaveChat', {}],
])(
  'a viewer whose access ends while a reply streams gets no further frame when %s, other viewers stream on',
  async (_, member, name, args) => {
    await agentHost()
    const chat = await newRuntimeChat({ participants: [{ memberId: bob, roleId: 'reader' }] })
    const aliceViewer = await openStream(chat)
    const bobViewer = await openStream(chat, { token: await sessionTokenOf(database, acme, bob) })
    await Promise.all([aliceViewer.subscribed, bobViewer.subscribed])
    const textsOf = (frames: string[]) => frames.flatMap((frame) => JSON.parse(frame).text ?? [])
    const question = await prompt(chat, 'stub:linger Stream until removed')
    await holds.reached('linger')
    await waitFor(() => textsOf(bobViewer.frames).length > 0)
    expect(await mutate(member, `conversation.${name}`, { workspaceId: acme, chatId: chat, ...args })).toEqual(
      succeeded,
    )
    const framesAtRevocation = [...bobViewer.frames]
    await holds.release('linger')
    await answered(question)
    await turnEnded(chat)
    expect(bobViewer.frames).toEqual(framesAtRevocation)
    expect(textsOf(aliceViewer.frames).join('')).toBe(replyOf(1).body)
  },
)

test('removing the owner of a runtime chat closes their stream, stops the turn and the runtime, and freezes the chat until an admin transfers it', async () => {
  await agentHost()
  const chat = await newRuntimeChat({ ownerId: bob, participants: [{ memberId: alice, roleId: 'prompter' }] })
  const aliceViewer = await openStream(chat)
  const bobViewer = await openStream(chat, { token: await sessionTokenOf(database, acme, bob) })
  await Promise.all([aliceViewer.subscribed, bobViewer.subscribed])
  const question = await prompt(chat, 'stub:linger Stream until the owner leaves')
  await holds.reached('linger')
  expect(await mutate(aliceInAcme, 'workspace.removeMember', { workspaceId: acme, memberId: bob })).toEqual(succeeded)
  await bobViewer.closed
  await turnEnded(chat)
  expect(await repliesTo(question)).toContainEqual({ kind: 'notice', body: 'Stopped by Alice', detail: null })
  await waitFor(async () => (await runtimeOf(chat)).state === 'stopped')
  await holds.release('linger')
  expect(
    await mutate(aliceInAcme, 'conversation.sendMessage', {
      workspaceId: acme,
      id: 'frozen',
      chatId: chat,
      text: 'Hi',
    }),
  ).toEqual(failedWith('This chat is frozen: its owner left the workspace'))
  expect(
    await mutate(aliceInAcme, 'workspace.transferChat', { workspaceId: acme, chatId: chat, ownerId: alice }),
  ).toEqual(succeeded)
  await answered(await prompt(chat, 'Back after the transfer'))
  expect((await runtimeOf(chat)).state).toBe('running')
})

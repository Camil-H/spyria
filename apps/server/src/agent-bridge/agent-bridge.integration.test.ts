import { expect, setDefaultTimeout, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { zeroDrizzle } from '@rocicorp/zero/server/adapters/drizzle'
import { commandOutputPathOf, rebuildMessages } from '@spyria/conversation/server'
import { schema } from '@spyria/db/zero'
import { secretsKeyringOf } from '../auth/secret-box.ts'
import { maximumJobAttempts, startJobWorker } from '../job-worker.ts'
import {
  acme,
  alice,
  aliceInAcme,
  bob,
  bobInAcme,
  captureConsole,
  captureLogs,
  chatAccessRows,
  chatAs,
  failedWith,
  globex,
  issueTestSession,
  sessionTokenOf,
  startAgentStack,
  succeeded,
  testAuthSettings,
  testSecretsKey,
  waitFor,
} from '../testing/testing.ts'

setDefaultTimeout(30_000)
const previousSecretsKey = 'previous-agent-bridge-secrets-key-0123456789'
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
} = await startAgentStack({
  llm: { model: 'openai/mistral/codestral-latest' },
  secretsKeyring: secretsKeyringOf(testSecretsKey, [previousSecretsKey]),
})
const repliesTo = (messageId: string) => stack.repliesTo(messageId, ['kind', 'body'])
const answered = stack.answered
const agentHost = () => stack.agentHost('Agent host', { holdUrl })
const replyOf = (turn: number) => ({
  kind: 'agent' as const,
  body: `[t${turn}] Hello from the stub (model spyria/mistral/codestral-latest, mode default).`,
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
  expect(llmToken).not.toBe(runtimeHosts.sandboxProvider.apiKeyOf({ workspaceId: acme, runtimeId: runtime.id }))
  expect(runtime.llm_token_hash).toBe(createHash('sha256').update(llmToken).digest('hex'))
  expect(launch?.agent.acp_model).toBe('spyria/mistral/codestral-latest')
  expect(launch?.agent.acp_command.at(-1)).toEndWith('exec pi --mode rpc --no-themes')
  expect(relay.socketPaths).toEqual([`/sockets/events/${runtime.agent_conversation_id}?after=0`])
  expect(relay.prompts).toEqual(['Find the latest pricing'])
  expect(await repliesTo(question)).toEqual([replyOf(1)])
})

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72, 68, 82])
const pdf = new TextEncoder().encode('%PDF-1.7 report')
const uploadTo = async (chat: string, name: string, content: Uint8Array<ArrayBuffer>) =>
  (await (
    await app.request(`/api/chats/${chat}/attachments?${new URLSearchParams({ name })}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${await sessionTokenOf(database, acme, alice)}` },
      body: content,
    })
  ).json()) as { id: string }
const agentHostFailingUploads = async (failures: number) => {
  let uploadAttempts = 0
  const host = await stack.agentHost('Agent host', {
    holdUrl,
    containerAgentOf: (relay) => ({
      ...relay.containerAgent,
      respond: async (request, container) => {
        if (!request.path.endsWith('/attachments')) return relay.containerAgent.respond(request, container)
        uploadAttempts += 1
        return uploadAttempts > failures
          ? relay.containerAgent.respond(request, container)
          : { status: 500, body: '{"error":"Failed on purpose"}' }
      },
    }),
  })
  return { ...host, uploadAttempts: () => uploadAttempts }
}

test('a prompt’s attachments are saved in the runtime and named to the agent by path, and Pi is shown the image but not the PDF', async () => {
  const { relay } = await agentHost()
  const chat = await newRuntimeChat()
  const attachments = [await uploadTo(chat, 'chart.png', png), await uploadTo(chat, 'report.pdf', pdf)]
  const question = await prompt(chat, 'What is this?', aliceInAcme, attachments)
  await answered(question)
  await turnEnded(chat)

  const [text = ''] = relay.prompts
  const savedPaths = [...text.matchAll(/(\/\S+\/(chart\.png|report\.pdf))/g)].map(([path]) => path)
  expect(text).toBe(
    `What is this?\n\nAttached files, saved in your workspace: ${savedPaths[0]} (image/png, 16 B), ${savedPaths[1]} (application/pdf, 15 B)`,
  )
  expect(savedPaths.map((path) => path.split('/').slice(-2).join('/'))).toEqual(
    attachments.map(({ id }, index) => `${id}/${['chart.png', 'report.pdf'][index]}`),
  )
  expect(new Uint8Array(await Bun.file(savedPaths[0] ?? '').arrayBuffer())).toEqual(png)
  expect(await Bun.file(savedPaths[1] ?? '').text()).toBe('%PDF-1.7 report')
  expect(await repliesTo(question)).toEqual([
    { kind: 'agent', body: `[t1] Saw image image/png 16 B. ${replyOf(1).body.slice(5)}` },
  ])
})

test('an attachment the runtime fails to save once is saved on the retry, and the prompt reaches the agent once, with its path', async () => {
  const { relay, uploadAttempts } = await agentHostFailingUploads(1)
  const chat = await newRuntimeChat()
  const question = await prompt(chat, 'What is this?', aliceInAcme, [await uploadTo(chat, 'chart.png', png)])
  await answered(question)
  await turnEnded(chat)

  expect(uploadAttempts()).toBe(2)
  expect(relay.prompts).toHaveLength(1)
  expect(relay.prompts[0]).toMatch(
    /^What is this\?\n\nAttached files, saved in your workspace: \/\S+\/chart\.png \(image\/png, 16 B\)$/,
  )
})

test('an attachment the runtime never saves is named to the agent as not readable on the last attempt, and logged without its content', async () => {
  const logs = captureLogs()
  try {
    const { relay, uploadAttempts } = await agentHostFailingUploads(Number.POSITIVE_INFINITY)
    const chat = await newRuntimeChat()
    const attachment = await uploadTo(chat, 'chart.png', png)
    const question = await prompt(chat, 'What is this?', aliceInAcme, [attachment])
    await answered(question)
    await turnEnded(chat)

    expect(relay.prompts).toEqual(['What is this?\n\nAttached, not readable by you: chart.png (image/png, 16 B)'])
    expect(uploadAttempts()).toBe(maximumJobAttempts)
    const unsaved = logs.events.filter(({ event }) => event === 'agent.attachment_unsaved')
    expect(unsaved).toHaveLength(1)
    expect(unsaved[0]).toMatchObject({
      severity: 'WARN',
      attributes: { 'workspace.id': acme, 'chat.id': chat, 'attachment.id': attachment.id },
    })
    expect(JSON.stringify(unsaved)).not.toContain(Buffer.from(png).toString('base64'))
  } finally {
    logs.restore()
  }
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

test('a prompt whose send answer is lost after the agent took it is sent again on retry, runs once and ends its turn once', async () => {
  let isAnswerLost = true
  const { relay } = await stack.agentHost('Agent host', {
    holdUrl,
    containerAgentOf: (relay) => ({
      ...relay.containerAgent,
      respond: async (request, container) => {
        const response = await relay.containerAgent.respond(request, container)
        if (!request.path.endsWith('/events') || !isAnswerLost) return response
        isAnswerLost = false
        throw new Error('The answer was lost')
      },
    }),
  })
  const chat = await newRuntimeChat()
  const question = await prompt(chat, 'stub:linger Hello')
  await waitFor(() => relay.prompts.length === 2)
  expect(await turnOf(chat)).toBe(question)

  await holds.release('linger')
  await answered(question)
  await turnEnded(chat)
  expect(await repliesTo(question)).toEqual([replyOf(1)])
  const next = await prompt(chat, 'Again')
  await answered(next)
  expect(await repliesTo(next)).toEqual([replyOf(2)])
})

const agentHostLosingFirstPrompt = async ({ ignoresStop = false } = {}) => {
  const firstSend = Promise.withResolvers<void>()
  const loseFirstPrompt = Promise.withResolvers<void>()
  let isFirstSend = true
  const host = await stack.agentHost('Agent host', {
    holdUrl,
    containerAgentOf: (relay) => ({
      ...relay.containerAgent,
      respond: async (request, container) => {
        if (ignoresStop && request.path.endsWith('/interrupt')) return { status: 200, body: '{}' }
        if (!request.path.endsWith('/events') || !isFirstSend) return relay.containerAgent.respond(request, container)
        isFirstSend = false
        firstSend.resolve()
        await loseFirstPrompt.promise
        return { status: 500, body: '{"error":"Failed on purpose"}' }
      },
    }),
  })
  return { ...host, firstSend: firstSend.promise, loseFirstPrompt: loseFirstPrompt.resolve }
}
const chatWithPromptStoppedBeforeDelivery = async (host: Awaited<ReturnType<typeof agentHostLosingFirstPrompt>>) => {
  const chat = await newRuntimeChat()
  const viewer = await openStream(chat)
  await viewer.subscribed
  await prompt(chat, 'Never delivered')
  await host.firstSend
  expect(await mutate(aliceInAcme, 'conversation.stopAgent', { workspaceId: acme, chatId: chat })).toEqual(succeeded)
  await turnEnded(chat)
  host.loseFirstPrompt()
  return { chat, viewer }
}

test('stopping a prompt that never reached the agent: the next prompt streams, is answered under itself, and its turn ends', async () => {
  const host = await agentHostLosingFirstPrompt()
  const { chat, viewer } = await chatWithPromptStoppedBeforeDelivery(host)

  const next = await prompt(chat, 'Hello')
  await answered(next)
  await turnEnded(chat)
  expect(await repliesTo(next)).toEqual([replyOf(1)])
  const streamed = viewer.frames.map((frame) => JSON.parse(frame)).filter((frame) => frame.text !== undefined)
  expect(streamed.map((frame) => frame.text).join('')).toBe(replyOf(1).body)
  expect(streamed.every((frame) => frame.promptId === next)).toBe(true)
  expect(host.relay.prompts).toEqual(['Hello'])
})

test('a stop the agent ignores for a prompt it never received still lets the next prompt’s turn close, and the prompt after it is answered under itself', async () => {
  const host = await agentHostLosingFirstPrompt({ ignoresStop: true })
  const { chat } = await chatWithPromptStoppedBeforeDelivery(host)

  await prompt(chat, 'Hello')
  await waitFor(() => host.relay.prompts.length === 1)
  await turnEnded(chat)
  const after = await prompt(chat, 'Again')
  await answered(after)
  await turnEnded(chat)
  expect(await repliesTo(after)).toEqual([replyOf(2)])
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
    { type: 'command', command: 'npm test', exitCode: 1, isExitCodeDerived: true, output: 'exit code 1' },
    { type: 'command', command: 'npm test', exitCode: 2, output: 'one\ntwo\nfailed' },
  ])
  expect(steps[3]).not.toHaveProperty('isExitCodeDerived')
  expect(live.at(-1)?.kind).toBe('agent')
  expect(live.at(-1)?.body).toContain('Hello from the stub')
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
    for (const secret of [
      runtimeHosts.sandboxProvider.apiKeyOf({ workspaceId: acme, runtimeId: runtime.id }),
      llmToken,
      runtime.llm_token_hash,
    ]) {
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

test('a started agent session reaches viewers live as sessionStarted and is still stored', async () => {
  await agentHost()
  const chat = await newRuntimeChat()
  const viewer = await openStream(chat)
  await viewer.subscribed
  await answered(await prompt(chat, 'Hello'))
  await turnEnded(chat)
  const sessionStartsIn = (frames: string[]) =>
    frames.map((frame) => JSON.parse(frame)).filter((frame) => frame.sessionStarted !== undefined)
  await waitFor(() => sessionStartsIn(viewer.frames).length === 1)
  expect(sessionStartsIn(viewer.frames)).toEqual([{ chatId: chat, sessionStarted: true }])
  const storedUpdates = (await storedAgentEventsOf(chat)).map(
    (event) => (event.payload as { event: { update?: { sessionUpdate?: string } } }).event.update?.sessionUpdate,
  )
  expect(storedUpdates).toContain('session_started')
})

test('Restart session tells viewers the session started again on an idle chat whose event socket closed, and that it starts on the next message when there is none', async () => {
  const { relay } = await agentHost()
  const framesOf = (viewer: { frames: string[] }) => viewer.frames.map((frame) => JSON.parse(frame))
  const restart = (chat: string) =>
    mutate(aliceInAcme, 'conversation.restartSession', { workspaceId: acme, chatId: chat })

  const idle = await newRuntimeChat()
  await answered(await prompt(idle, 'Hello'))
  await turnEnded(idle)
  relay.dropSockets()
  await Bun.sleep(200)
  const socketsBefore = relay.socketPaths.length
  const idleViewer = await openStream(idle)
  await idleViewer.subscribed
  expect(await restart(idle)).toEqual(succeeded)
  await waitFor(() => framesOf(idleViewer).some((frame) => frame.sessionStarted === true))
  expect(relay.socketPaths.length).toBeGreaterThan(socketsBefore)
  expect(framesOf(idleViewer).filter((frame) => frame.sessionStartsOnNextMessage)).toEqual([])

  const fresh = await newRuntimeChat()
  const freshViewer = await openStream(fresh)
  await freshViewer.subscribed
  expect(await restart(fresh)).toEqual(succeeded)
  await waitFor(() => framesOf(freshViewer).some((frame) => frame.sessionStartsOnNextMessage === true))
  expect(framesOf(freshViewer).filter((frame) => frame.sessionStartsOnNextMessage)).toEqual([
    { chatId: fresh, sessionStartsOnNextMessage: true },
  ])
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
    approval: {
      server: 'crm',
      tool: 'update',
      arguments: '{}',
      prompterName: 'Bob',
      answererId: alice,
      answererName: 'Alice',
    },
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
    { kind: 'step', body: 'error' },
    { kind: 'notice', body: 'The agent stopped with an error' },
  ])

  host.failing('create')
  const unstartable = await newRuntimeChat()
  const neverStarted = await prompt(unstartable, 'Start please')
  await answered(neverStarted)
  expect(await repliesTo(neverStarted)).toEqual([{ kind: 'notice', body: 'The agent could not start' }])
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
  expect(await repliesTo(promptId)).toEqual([{ kind: 'notice', body: 'Bob has no LLM key in this workspace' }])
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
  expect(await repliesTo(question)).toEqual([replyOf(1), { kind: 'step', body: 'error' }])
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
  expect(await repliesTo(promptId)).toEqual([{ kind: 'notice', body: 'Bob can no longer prompt in this chat' }])
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

test('signing out closes the stream of that session at once and leaves the other sessions of the member streaming', async () => {
  const chat = await newRuntimeChat()
  const signedOut = await issueTestSession(database, acme, alice)
  const signedOutViewer = await openStream(chat, { token: signedOut.token })
  const otherViewer = await openStream(chat)
  await Promise.all([signedOutViewer.subscribed, otherViewer.subscribed])
  const logout = await app.request('/auth/logout', {
    method: 'POST',
    headers: {
      origin: testAuthSettings.appOrigin,
      'x-spyria-csrf': '1',
      'content-type': 'application/json',
      cookie: `spyria_s_${acme}=${signedOut.sessionId}`,
    },
    body: JSON.stringify({ workspaceId: acme }),
  })
  expect(logout.status).toBe(204)
  expect(await signedOutViewer.closed).toBe(4001)
  await otherViewer.resubscribe()
})

test('a stream closes once its session ends by any path, such as an SSO change or an operator command deleting it, and other sessions stream on', async () => {
  const chat = await newRuntimeChat()
  const ending = await issueTestSession(database, acme, alice)
  const endingViewer = await openStream(chat, { token: ending.token })
  const otherViewer = await openStream(chat)
  await Promise.all([endingViewer.subscribed, otherViewer.subscribed])
  await database.$client`delete from sessions where workspace_id = ${acme} and id = ${ending.sessionId}`
  expect(await endingViewer.closed).toBe(4001)
  await otherViewer.resubscribe()
})

test.each<[string, (bobToken: string) => Promise<unknown>, unknown]>([
  [
    'signs out everywhere',
    async (bobToken) =>
      (
        await app.request('/auth/sign-out-everywhere', {
          method: 'POST',
          headers: { authorization: `Bearer ${bobToken}` },
        })
      ).status,
    204,
  ],
  [
    'is signed out everywhere by an admin',
    () => mutate(aliceInAcme, 'workspace.endMemberSessions', { workspaceId: acme, memberId: bob }),
    succeeded,
  ],
])('every stream of a member who %s closes at once, and other members stream on', async (_, signOut, outcome) => {
  const chat = await newRuntimeChat({ participants: [{ memberId: bob, roleId: 'reader' }] })
  const bobToken = await sessionTokenOf(database, acme, bob)
  const bobViewers = [
    await openStream(chat, { token: bobToken }),
    await openStream(chat, { token: await sessionTokenOf(database, acme, bob) }),
  ]
  const aliceViewer = await openStream(chat)
  await Promise.all([...bobViewers, aliceViewer].map((viewer) => viewer.subscribed))
  expect(await signOut(bobToken)).toEqual(outcome)
  for (const viewer of bobViewers) expect(await viewer.closed).toBe(4001)
  await aliceViewer.resubscribe()
})

test('a stream closes when its token expires and stays open when a renewed token arrives first', async () => {
  const chat = await newRuntimeChat()
  const expiring = await openStream(chat, {
    token: (await issueTestSession(database, acme, alice, undefined, 2)).token,
  })
  const renewed = await openStream(chat, { token: (await issueTestSession(database, acme, alice, undefined, 2)).token })
  await Promise.all([expiring.subscribed, renewed.subscribed])
  renewed.authenticate(await sessionTokenOf(database, acme, alice))
  expect(await expiring.closed).toBe(4001)
  await renewed.resubscribe()
})

test.each([
  ['another member', () => sessionTokenOf(database, acme, bob)],
  ['another workspace', () => sessionTokenOf(database, globex, alice)],
  ['an invalid token', async () => 'not-a-token'],
])('a stream that receives a token of %s closes', async (_, tokenOf) => {
  const viewer = await openStream(await newRuntimeChat())
  await viewer.subscribed
  viewer.authenticate(await tokenOf())
  expect(await viewer.closed).toBe(4001)
})

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
  expect(await repliesTo(question)).toContainEqual({ kind: 'notice', body: 'Stopped by Alice' })
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

test('an archived chat takes no new message nor retry, and a prompt or session start still queued for it places no runtime', async () => {
  const { launches } = await agentHost()
  const chat = await newRuntimeChat()
  const onMachine = await newRuntimeChat({ harness: 'claude-code' })
  for (const archived of [chat, onMachine])
    expect(await mutate(aliceInAcme, 'workspace.archiveChat', { workspaceId: acme, chatId: archived })).toEqual(
      succeeded,
    )
  const chatArchived = failedWith('This chat is archived: it takes no new messages')
  expect(
    await mutate(aliceInAcme, 'conversation.sendMessage', {
      workspaceId: acme,
      id: 'archived',
      chatId: chat,
      text: 'Hi',
    }),
  ).toEqual(chatArchived)
  expect(await mutate(aliceInAcme, 'conversation.retryAgent', { workspaceId: acme, chatId: chat })).toEqual(
    chatArchived,
  )

  const queuedPrompt = `message-${crypto.randomUUID()}`
  await database.$client`
    insert into messages (workspace_id, chat_id, id, seq, kind, author_id, body, created_at)
    values (${acme}, ${chat}, ${queuedPrompt}, 1, 'member', ${alice}, 'Queued before the archive', now())`
  const jobs = agentBridge.forDatabase(database).jobs
  expect(
    await jobs['agent.prompt']({ workspaceId: acme, payload: { messageId: queuedPrompt }, isLastAttempt: false }),
  ).toBeUndefined()
  expect(
    await jobs['agent.start-session']({ workspaceId: acme, payload: { chatId: onMachine }, isLastAttempt: false }),
  ).toBeUndefined()
  expect(await turnOf(chat)).toBeNull()
  expect(
    (await database.$client`select id from runtimes where chat_id in (${chat}, ${onMachine})`).map(({ id }) => id),
  ).toEqual([])
  expect(launches()).toEqual([])
})

test('a runtime started under a previous secrets key is still reached with its key after the rotation', async () => {
  const { host, relay } = await agentHost()
  const chat = await newRuntimeChat()
  await answered(await prompt(chat, 'Before the rotation'))
  await turnEnded(chat)
  const runtime = await runtimeOf(chat)
  const container = host.containers.get(runtime.id)
  if (!container) throw new Error(`No container for runtime ${runtime.id}`)
  const previousKeyId = secretsKeyringOf(previousSecretsKey).currentKeyId
  await relay.restart()
  container.apiKey = runtimeHosts.sandboxProvider.apiKeyOf({
    workspaceId: acme,
    runtimeId: runtime.id,
    apiKeyId: previousKeyId,
  })
  await database.$client`update runtimes set api_key_id = ${previousKeyId} where id = ${runtime.id}`

  const afterRotation = await prompt(chat, 'After the rotation')
  await answered(afterRotation)
  expect(await repliesTo(afterRotation)).toEqual([
    { kind: 'agent', body: expect.stringContaining('Hello from the stub') },
  ])
  expect(container.apiKey).not.toBe(runtimeHosts.sandboxProvider.apiKeyOf({ workspaceId: acme, runtimeId: runtime.id }))
})

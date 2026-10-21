import { afterAll, expect, setDefaultTimeout, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zeroDrizzle } from '@rocicorp/zero/server/adapters/drizzle'
import { createSpyriaAgentClient } from '@spyria/conversation/server'
import { testGatewayAdmin } from '@spyria/db/testing'
import { schema } from '@spyria/db/zero'
import { runtimeHostId } from '@spyria/kernel'
import { createBifrostUsageLogs, syncUsageNow } from '@spyria/usage/server'
import { websocket } from 'hono/bun'
import { createApp } from '../app.ts'
import { createModelCallRelay } from '../llm-relay.ts'
import { createRuntimeHostGateway } from '../runtime-hosts/gateway.ts'
import { readSpyriaAgentImage } from '../spyria-agent-image.ts'
import { withSpan } from '../telemetry.ts'
import { startTestTelemetry } from '../testing/telemetry.ts'
import {
  acme,
  addLlmKey,
  alice,
  aliceInAcme,
  bob,
  gatewayLogsOf,
  openSharedTestApp,
  runtimeTurn,
  sessionTokenOf,
  testAuthSettings,
  waitFor,
} from '../testing/testing.ts'
import { createAgentBridge } from './bridge.ts'

setDefaultTimeout(180_000)
const docker = (...args: string[]) => Bun.spawnSync(['docker', ...args], { stderr: 'pipe' })
const spyriaImage = await readSpyriaAgentImage()
if (!spyriaImage || docker('image', 'inspect', spyriaImage).exitCode !== 0)
  throw new Error('Spyria image missing: run bun run agent:build')

const { database, gateway, llmGateway, fakeLlmBodies, setFakeLlmScript } = await openSharedTestApp()
const runtimeHosts = createRuntimeHostGateway({
  databases: () => [database],
  spyriaAgentImage: spyriaImage,
  relayModelCall: createModelCallRelay({ llmGateway, agentBridge: () => agentBridge }),
})
const agentBridge = createAgentBridge({ sandboxProvider: runtimeHosts.sandboxProvider, spyriaAgentImage: spyriaImage })
const app = createApp({ database, ...testAuthSettings, llmGateway, runtimeHosts, agentBridge })
const server = Bun.serve({ port: 0, fetch: app.fetch, websocket })
const deployment = `spyria-test-${crypto.randomUUID().slice(0, 8)}`
const prefix = `${deployment}-`
const stateDirectory = mkdtempSync(join(tmpdir(), 'spyria-test-host-'))
const hostProgram = new URL('../../../host/src/main.ts', import.meta.url).pathname
let hostProcess: ReturnType<typeof Bun.spawn> | undefined
const hostOutput: string[] = []
const listed = (...command: string[]) =>
  docker(...command, '--filter', `name=^${prefix}`)
    .stdout.toString()
    .split('\n')
    .filter(Boolean)
afterAll(async () => {
  setFakeLlmScript(undefined)
  agentBridge.release(database)
  hostProcess?.kill()
  await hostProcess?.exited
  const containers = listed('ps', '-aq')
  if (containers.length > 0) docker('rm', '-f', ...containers)
  for (const volume of listed('volume', 'ls', '-q')) docker('volume', 'rm', '-f', volume)
  for (const network of listed('network', 'ls', '-q')) docker('network', 'rm', network)
  void server.stop(true)
  rmSync(stateDirectory, { recursive: true, force: true })
})

const startHost = async () => {
  const added = await app.request('/api/runtime-hosts', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${await sessionTokenOf(database, acme, aliceInAcme.userId)}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ personal: true }),
  })
  const { id, code } = (await added.json()) as { id: string; code: string }
  const spawned = Bun.spawn(
    [process.execPath, hostProgram, '--personal', `http://localhost:${server.port}/h/${code}`],
    {
      env: { ...process.env, SPYRIA_HOST_STATE_DIR: stateDirectory, SPYRIA_DEPLOYMENT: deployment },
      stdout: 'pipe',
      stderr: 'inherit',
    },
  )
  hostProcess = spawned
  void (async () => {
    for await (const chunk of spawned.stdout) {
      hostOutput.push(new TextDecoder().decode(chunk))
      process.stdout.write(chunk)
    }
  })()
  await waitFor(
    async () => (await database.$client`select status from runtime_hosts where id = ${id}`)[0]?.status === 'online',
    30_000,
  )
  return id
}

const apiKey = 'test-api-key-0123456789abcdef'
type AgentTransport = ReturnType<typeof runtimeHosts.sandboxProvider.connect>
let runtimeStarted: Promise<{ id: string; transport: AgentTransport }> | undefined
const startRuntime = async () => {
  const id = await startHost()
  const host = { workspaceId: acme, hostId: runtimeHostId(id) }
  await runtimeHosts.prepare(host, spyriaImage)
  const runtime = { ...host, runtimeId: 'pi-smoke' }
  await runtimeHosts.sandboxProvider.create({ ...runtime, image: spyriaImage, apiKey })
  await runtimeHosts.sandboxProvider.start(runtime)
  const transport = runtimeHosts.sandboxProvider.connect(runtime)
  const isReady = () =>
    transport.fetch({ method: 'GET', path: '/ready', timeoutMilliseconds: 1000 }).then(
      (response) => response.status === 200,
      () => false,
    )
  await waitFor(isReady, 30_000)
  return { id, transport }
}
const runtime = () => {
  runtimeStarted ??= startRuntime()
  return runtimeStarted
}

type Update = {
  sessionUpdate?: string
  stopReason?: string
  sessionId?: string
  content?: { text?: string }
  questionId?: string
  kind?: string
  title?: string
  status?: string
  rawOutput?: unknown
  currentModeId?: string
  cwd?: string
  entries?: unknown
}
const agentClient = createSpyriaAgentClient()
type AgentLlmChoice = Parameters<typeof agentClient.createConversation>[2]
const piConversationOf = async (transport: AgentTransport, token: string, llm: AgentLlmChoice) => {
  const conversation = { transport, apiKey, conversationId: crypto.randomUUID() }
  await agentClient.createConversation(conversation, token, llm)
  const updates: Update[] = []
  const socket = agentClient.openEvents(conversation, null, {
    onEvent: (event) => updates.push((event as { update?: Update }).update ?? {}),
    onClose: () => {},
  })
  const turnEnds = () => updates.filter((update) => update.sessionUpdate === 'turn_end')
  const answerOf = async (text: string) => {
    const start = updates.length
    const turn = turnEnds().length + 1
    await agentClient.sendMessage(conversation, text)
    await waitFor(() => turnEnds().length >= turn, 120_000)
    return updates
      .slice(start)
      .filter((update) => update.sessionUpdate === 'agent_message_chunk')
      .map((update) => update.content?.text ?? '')
      .join('')
  }
  const questionOf = async (kind: string) => {
    await waitFor(() => updates.some((update) => update.sessionUpdate === 'question' && update.kind === kind), 120_000)
    return updates.findLast((update) => update.sessionUpdate === 'question') ?? {}
  }
  return { conversation, updates, turnEnds, answerOf, questionOf, close: () => socket.close() }
}
const modelCallsOf = async (chatId: string, minimum: number) => {
  await gatewayLogsOf(gateway, `metadata_chat=${chatId}`, minimum)
  const usageLogs = createBifrostUsageLogs({
    url: gateway.url,
    adminUser: testGatewayAdmin.user,
    adminPassword: testGatewayAdmin.password,
    labels: { chat: chatId },
  })
  const zeroDatabase = zeroDrizzle(schema, database)
  await syncUsageNow(usageLogs, { workspaceId: acme, transact: (work) => zeroDatabase.transaction(work) })
  return database.$client`
    select prompter_id, owner_id, model, provider, status from model_calls where chat_id = ${chatId}`
}

test("Pi in Spyria's image answers through the LLM relay on the chat and Anthropic routes, streams its text to the events socket, ends the turn and each call is attributed to the prompter and the owner", async () => {
  await addLlmKey(bob, 'Mistral')
  await addLlmKey(bob, 'Anthropic')
  const { id, transport } = await runtime()
  const { chatId, token } = await runtimeTurn({ id }, bob)
  const { conversation, turnEnds, answerOf, close } = await piConversationOf(transport, token, {
    adapterModel: 'spyria/mistral/mistral-medium-latest',
    pi: {
      models: [
        { id: 'mistral/mistral-medium-latest', name: 'Mistral Medium', reasoning: false },
        { id: 'anthropic/claude-haiku-5-5', name: 'Haiku 5.5', reasoning: false, contextWindow: 200000 },
      ],
      compactionModel: 'mistral/mistral-small-latest',
    },
  })
  expect(await answerOf('Hello Pi')).toBe('Understood, working on it.')
  await agentClient.switchModel(conversation, 'spyria-anthropic/anthropic/claude-haiku-5-5')
  expect(await answerOf('Hello Pi on Anthropic')).toContain('Understood')
  expect(turnEnds().map((update) => update.stopReason)).toEqual(['end_turn', 'end_turn'])
  close()

  const calls = await modelCallsOf(chatId, 2)
  expect(new Set(calls.map((call) => JSON.stringify(call)))).toEqual(
    new Set([
      JSON.stringify({
        prompter_id: bob,
        owner_id: alice,
        model: 'mistral-medium-latest',
        provider: 'mistral',
        status: 'success',
      }),
      JSON.stringify({
        prompter_id: bob,
        owner_id: alice,
        model: 'claude-haiku-5-5',
        provider: 'anthropic',
        status: 'success',
      }),
    ]),
  )
})

test('a model switch keeps the conversation: the next request on a curated model of another provider, and after a relaunch on the same session with a picked model, carries the earlier turns', async () => {
  await addLlmKey(bob, 'Mistral')
  await addLlmKey(bob, 'Anthropic')
  const { id, transport } = await runtime()
  const { token } = await runtimeTurn({ id }, bob)
  const models = [
    { id: 'mistral/mistral-medium-latest', name: 'Mistral Medium', reasoning: false },
    { id: 'anthropic/claude-haiku-5-5', name: 'Haiku 5.5', reasoning: false, contextWindow: 200000 },
  ]
  const llm = {
    adapterModel: 'spyria/mistral/mistral-medium-latest',
    pi: { models, compactionModel: 'mistral/mistral-medium-latest' },
  }
  const bodiesBefore = fakeLlmBodies.length
  const requestOf = (text: string) => fakeLlmBodies.slice(bodiesBefore).find((body) => body.includes(text)) ?? ''
  const first = await piConversationOf(transport, token, llm)
  await first.answerOf('The code word is PAPAYA')
  await agentClient.switchModel(first.conversation, 'spyria-anthropic/anthropic/claude-haiku-5-5')
  await first.answerOf('Curated switch: what is the code word?')
  const sessionId = first.updates.find((update) => update.sessionUpdate === 'session_started')?.sessionId
  first.close()
  await agentClient.deleteConversation(first.conversation)

  const picked = { id: 'mistral/mistral-small-latest', name: 'Mistral Small', reasoning: false }
  const relaunched = await piConversationOf(transport, token, {
    adapterModel: 'spyria/mistral/mistral-small-latest',
    pi: { models: [...models, picked], compactionModel: 'mistral/mistral-medium-latest' },
    resumeSessionId: sessionId,
  })
  await relaunched.answerOf('Picked switch: what is the code word?')
  relaunched.close()
  expect(relaunched.updates.find((update) => update.sessionUpdate === 'session_started')).toMatchObject({
    sessionId,
    resumeFailed: false,
  })
  expect(requestOf('Curated switch')).toContain('"model":"claude-haiku-5-5"')
  expect(requestOf('Curated switch')).toContain('The code word is PAPAYA')
  expect(requestOf('Picked switch')).toContain('"model":"mistral-small-latest"')
  expect(requestOf('Picked switch')).toContain('The code word is PAPAYA')
  expect(requestOf('Picked switch')).toContain('Curated switch: what is the code word?')
})

test('a long Pi conversation compacts on the compaction model, recorded with prompter and owner, and a new conversation loads the session without replaying it and keeps its context', async () => {
  await addLlmKey(bob, 'Mistral')
  const summary = 'Summary of the earlier turns: the word to remember is PAPAYA.'
  setFakeLlmScript({ summary })
  const { id, transport } = await runtime()
  const { chatId, token } = await runtimeTurn({ id }, bob)
  const llm = {
    adapterModel: 'spyria/mistral/mistral-medium-latest',
    pi: {
      models: [
        { id: 'mistral/mistral-medium-latest', name: 'Mistral Medium', reasoning: false, contextWindow: 4000 },
        { id: 'mistral/mistral-small-latest', name: 'Mistral Small', reasoning: false, contextWindow: 4000 },
      ],
      compactionModel: 'mistral/mistral-small-latest',
      compaction: { reserveTokens: 3999, keepRecentTokens: 1 },
    },
  }
  const first = await piConversationOf(transport, token, llm)
  for (const text of ['Remember the word PAPAYA', 'Second turn', 'Third turn']) await first.answerOf(text)
  const sessionId = first.updates.find((update) => update.sessionUpdate === 'session_started')?.sessionId
  first.close()
  await agentClient.deleteConversation(first.conversation)

  const summaryRequests = fakeLlmBodies.filter((body) => body.startsWith('{"model":"mistral-small-latest"'))
  expect(summaryRequests.some((body) => body.includes('Remember the word PAPAYA'))).toBe(true)
  const calls = await modelCallsOf(chatId, 4)
  const attributed = { prompter_id: bob, owner_id: alice, provider: 'mistral', status: 'success' }
  expect(
    new Set(
      calls.map(({ prompter_id, owner_id, model, provider, status }) =>
        JSON.stringify({ prompter_id, owner_id, provider, status, model }),
      ),
    ),
  ).toEqual(
    new Set([
      JSON.stringify({ ...attributed, model: 'mistral-medium-latest' }),
      JSON.stringify({ ...attributed, model: 'mistral-small-latest' }),
    ]),
  )

  const loaded = await piConversationOf(transport, token, { ...llm, resumeSessionId: sessionId })
  await waitFor(() => loaded.updates.some((update) => update.sessionUpdate === 'session_started'), 30_000)
  expect(loaded.updates.find((update) => update.sessionUpdate === 'session_started')).toMatchObject({
    sessionId,
    resumeFailed: false,
  })
  const bodiesBefore = fakeLlmBodies.length
  expect(await loaded.answerOf('After the restart')).toBe('Understood, working on it.')
  loaded.close()
  expect(loaded.updates.filter((update) => update.sessionUpdate === 'user_message_chunk')).toEqual([])
  expect(JSON.stringify(loaded.updates)).not.toMatch(/PAPAYA|Second turn|Third turn/)
  const request = fakeLlmBodies.slice(bodiesBefore).find((body) => body.includes('After the restart'))
  expect(request).toContain(summary)
  expect(request?.split('After the restart')).toHaveLength(2)
})

test("Pi in Spyria's image runs a command with its output, asks through Spyria's extension and gets a free answer, in plan mode is refused a write and proposes a plan that is approved, keeps a plan with update_plan as its system prompt asks, streams text around a command once, and reports a provider error", async () => {
  await addLlmKey(bob, 'Mistral')
  const { id, transport } = await runtime()
  const { token } = await runtimeTurn({ id }, bob)
  const pi = await piConversationOf(transport, token, {
    adapterModel: 'spyria/mistral/mistral-medium-latest',
    pi: {
      models: [{ id: 'mistral/mistral-medium-latest', name: 'Mistral Medium', reasoning: false }],
      compactionModel: 'mistral/mistral-medium-latest',
    },
  })
  const finalOf = (title: string) =>
    pi.updates.findLast((update) => update.sessionUpdate === 'tool_call_update' && update.title === title)
  setFakeLlmScript({
    steps: [
      { command: 'echo one; echo two; exit 3' },
      { tool: 'ask_member', arguments: { question: 'Which database?', options: ['Postgres', 'SQLite'] } },
    ],
    text: 'Asked.',
  })
  const asked = pi.answerOf('Run it, then ask me')
  const question = await pi.questionOf('question')
  expect(question).toMatchObject({
    questions: [
      {
        id: 'answer',
        text: 'Which database?',
        options: [
          { value: 'Postgres', label: 'Postgres' },
          { value: 'SQLite', label: 'SQLite' },
        ],
        free: true,
      },
    ],
  })
  expect(
    await agentClient.answerQuestion(pi.conversation, String(question.questionId), {
      answers: {},
      free: { answer: 'MySQL' },
    }),
  ).toBe(200)
  expect(await asked).toBe('Asked.')
  expect(finalOf('echo one; echo two; exit 3')).toMatchObject({
    kind: 'execute',
    status: 'failed',
    rawOutput: { formatted_output: 'one\ntwo\n', exit_code: 3 },
  })
  expect(pi.updates.find((update) => update.sessionUpdate === 'question_answered')).toMatchObject({
    free: { answer: 'MySQL' },
  })
  expect(fakeLlmBodies.some((body) => body.includes('The member answered: MySQL'))).toBe(true)

  expect(await agentClient.setPlanMode(pi.conversation, true)).toBe(200)
  setFakeLlmScript({
    steps: [{ command: 'touch blocked.txt' }, { tool: 'propose_plan', arguments: { plan: '1. Create notes.txt' } }],
    text: 'Planned.',
  })
  const planned = pi.answerOf('Plan it')
  const plan = await pi.questionOf('plan')
  expect(plan).toMatchObject({ plan: '1. Create notes.txt' })
  expect(await agentClient.answerQuestion(pi.conversation, String(plan.questionId), { approve: true })).toBe(200)
  expect(await planned).toBe('Planned.')
  expect(finalOf('touch blocked.txt')).toMatchObject({
    status: 'failed',
    rawOutput: { formatted_output: expect.stringContaining('Plan mode: read only') },
  })
  expect(
    pi.updates.filter((update) => update.sessionUpdate === 'current_mode_update').map((update) => update.currentModeId),
  ).toEqual(['plan', 'default'])
  expect(fakeLlmBodies.some((body) => body.includes('The member approved the plan'))).toBe(true)
  expect(pi.updates.find((update) => update.sessionUpdate === 'workspace')).toMatchObject({ cwd: '/workspace/project' })

  setFakeLlmScript({ steps: [{ plan: [{ content: 'Create notes.txt', status: 'in_progress' }] }], text: 'Tracked.' })
  expect(await pi.answerOf('Track it')).toBe('Tracked.')
  const tracked = JSON.parse(fakeLlmBodies.findLast((body) => body.includes('Track it')) ?? '{}')
  expect(tracked.messages[0]).toMatchObject({
    role: 'system',
    content: expect.stringContaining('For multi-step work, keep the plan with update_plan; do not write plan files.'),
  })
  expect(
    tracked.tools.find((tool: { function: { name: string } }) => tool.function.name === 'update_plan').function
      .description,
  ).toContain('instead of plan or TODO files')
  expect(pi.updates.filter((update) => update.sessionUpdate === 'plan')).toEqual([
    { sessionUpdate: 'plan', entries: [{ content: 'Create notes.txt', status: 'in_progress', priority: 'medium' }] },
  ])
  expect(pi.updates.some((update) => update.title === 'update_plan')).toBe(false)
  setFakeLlmScript({
    steps: [{ command: 'echo checked', say: 'Let me check that first. ' }],
    text: 'The check passed, so every word streams once.',
  })
  expect(await pi.answerOf('Stream around a command')).toBe(
    'Let me check that first. The check passed, so every word streams once.',
  )
  setFakeLlmScript({ steps: [{ fail: 'Overloaded' }] })
  await pi.answerOf('Fail it')
  expect(pi.updates.slice(-2)).toMatchObject([
    { sessionUpdate: 'error' },
    { sessionUpdate: 'turn_end', stopReason: 'end_turn' },
  ])
  pi.close()
})

test('a turn through a real spyria-host and spyria-agent carries the server’s trace into their JSON lines', async () => {
  await addLlmKey(bob, 'Mistral')
  setFakeLlmScript(undefined)
  const { id, transport } = await runtime()
  const { token, promptId } = await runtimeTurn({ id }, bob)
  const telemetry = startTestTelemetry({})
  const linesOf = (text: string) =>
    text
      .split('\n')
      .filter((line) => line.startsWith('{'))
      .map((line) => JSON.parse(line))
  try {
    const traceId = await withSpan('test turn', {}, async (span) => {
      await runtimeHosts.sandboxProvider.status({ workspaceId: acme, hostId: runtimeHostId(id), runtimeId: 'pi-smoke' })
      const pi = await piConversationOf(transport, token, {
        adapterModel: 'spyria/mistral/mistral-medium-latest',
        pi: {
          models: [{ id: 'mistral/mistral-medium-latest', name: 'Mistral Medium', reasoning: false }],
          compactionModel: 'mistral/mistral-medium-latest',
        },
      })
      expect(await pi.answerOf('Hello traced Pi')).toBe('Understood, working on it.')
      pi.close()
      return span.spanContext().traceId
    })
    await waitFor(() =>
      linesOf(hostOutput.join('')).some((line) => line['event.name'] === 'host.command' && line.trace_id === traceId),
    )
    expect(linesOf(hostOutput.join('')).find((line) => line.trace_id === traceId)).toMatchObject({
      'service.name': 'spyria-host',
      'event.name': 'host.command',
      'host.command': 'status',
    })
    const agentLines = () => linesOf(docker('logs', `${prefix}rt-pi-smoke`).stdout.toString())
    await waitFor(() => agentLines().some((line) => line['event.name'] === 'agent.turn' && line.trace_id === traceId))
    expect(agentLines().find((line) => line['event.name'] === 'agent.listening')).toMatchObject({
      'service.name': 'spyria-agent',
    })
    expect(telemetry.lines().find((line) => line.event === 'gen_ai.call')).toMatchObject({
      'service.name': 'spyria-server',
      'turn.id': promptId,
      'gen_ai.request.model': 'mistral/mistral-medium-latest',
      'http.response.status_code': 200,
    })
  } finally {
    await telemetry.stop()
  }
})

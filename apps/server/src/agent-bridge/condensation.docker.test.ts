import { afterAll, expect, setDefaultTimeout, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type ChatId, chatId } from '@hq/kernel'
import { agentServerImage } from '@hq/runtime/server'
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
  openSharedTestApp,
  requestMutation,
  sessionTokenOf,
  succeeded,
  testAuthSettings,
  waitFor,
} from '../testing.ts'
import { createAgentBridge } from './bridge.ts'

setDefaultTimeout(180_000)
const docker = (...args: string[]) => Bun.spawnSync(['docker', ...args], { stderr: 'pipe' })
const hasImage = docker('image', 'inspect', agentServerImage).exitCode === 0
if (!hasImage) console.warn(`Skipping the condensation tests: docker pull ${agentServerImage}`)

const condensationScale = 0.1
const clearedOutput = '[Earlier output cleared to save context. Run the tool again if you need it.]'
const { database, gateway, llmGateway, setFakeLlmScript, fakeLlmBodies } = await openSharedTestApp()
const runtimeHosts = createRuntimeHostGateway({
  databases: () => [database],
  relayModelCall: createModelCallRelay({ llmGateway, agentBridge: () => agentBridge, condensationScale }),
})
const agentBridge = createAgentBridge({
  sandboxProvider: runtimeHosts.sandboxProvider,
  sessionClassifierOf: sessionClassifierOf(llmGateway),
  condensationScale,
})
const app = createApp({ database, ...testAuthSettings, llmGateway, runtimeHosts, agentBridge })
const server = Bun.serve({ port: 0, fetch: app.fetch, websocket })
const worker = startJobWorker(database, {
  pollIntervalMilliseconds: 20,
  sandboxProvider: runtimeHosts.sandboxProvider,
  agentBridge,
})
const prefix = `hq-test-${crypto.randomUUID().slice(0, 8)}-`
const stateDirectory = mkdtempSync(join(tmpdir(), 'hq-test-host-'))
const hostProgram = new URL('../../../host/src/main.ts', import.meta.url).pathname
let hostProcess: ReturnType<typeof Bun.spawn> | undefined
const listed = (...command: string[]) =>
  docker(...command, '--filter', `name=^${prefix}`)
    .stdout.toString()
    .split('\n')
    .filter(Boolean)
afterAll(async () => {
  setFakeLlmScript(undefined)
  await worker.stop()
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

const connectHost = async () => {
  const added = await app.request('/api/runtime-hosts', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${await sessionTokenOf(database, acme, aliceInAcme.userId)}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ name: 'Condensation host' }),
  })
  const { id, code } = (await added.json()) as { id: string; code: string }
  hostProcess = Bun.spawn(['bun', hostProgram, `http://localhost:${server.port}/h/${code}`], {
    env: { ...process.env, HQ_HOST_STATE_DIR: stateDirectory, HQ_HOST_PREFIX: prefix },
    stdout: 'inherit',
    stderr: 'inherit',
  })
  await waitFor(
    async () => (await database.$client`select status from runtime_hosts where id = ${id}`)[0]?.status === 'online',
  )
}
let connectedHost: Promise<void> | undefined
const newRuntimeChat = async () => {
  connectedHost ??= connectHost()
  await connectedHost
  const id = `chat-${crypto.randomUUID()}`
  await database.$client`
    insert into chats (workspace_id, id, type, owner_kind, owner_user_id, name, default_model, archived, created_at)
    values (${acme}, ${id}, 'runtime', 'user', ${alice}, 'Condensation chat', 'fake/fake-medium', false, now())`
  return chatId(id)
}
const promptAndAnswer = async (chat: ChatId, text: string) => {
  const id = `message-${crypto.randomUUID()}`
  expect(
    await requestMutation(app, database, aliceInAcme, 'conversation.sendMessage', {
      workspaceId: acme,
      id,
      chatId: chat,
      text,
    }),
  ).toEqual(succeeded)
  await waitFor(
    async () =>
      (await database.$client`select agent_turn_message_id from chats where id = ${chat}`)[0]?.agent_turn_message_id ===
        null &&
      (await database.$client`select 1 from messages where reply_to_id = ${id} and kind = 'agent'`).length > 0,
    150_000,
  )
}

type Message = { role: string; content?: unknown; tool_calls?: object[] }
type Request = { model: string; messages: Message[]; tools?: object[] }
const longCommands = (count: number, from = 0) =>
  Array.from({ length: count }, (_, index) => ({
    command: `seq ${(from + index) * 1000} ${(from + index) * 1000 + 500}`,
  }))
const requestsSince = (start: number) =>
  fakeLlmBodies
    .slice(start)
    .filter(Boolean)
    .map((body) => ({ request: JSON.parse(body) as Request }))
const agentRequestsSince = (start: number, firstPrompt: string) =>
  requestsSince(start).filter(
    ({ request }) =>
      request.tools?.length &&
      JSON.stringify(request.messages.find((message) => message.role === 'user')).includes(firstPrompt),
  )
const outputsOf = (request: Request) => request.messages.filter((message) => message.role === 'tool')
const isCleared = (message: Message) => JSON.stringify(message.content).includes(clearedOutput)
const callsOf = (request: Request) => request.messages.flatMap((message) => message.tool_calls ?? [])
type Log = { model: string; metadata: Record<string, string> }
const condenserLogsOf = async (chat: ChatId) => {
  let logs: Log[] = []
  await waitFor(async () => {
    logs = (
      (await gateway.call<{ logs: Log[] | null }>(`/api/logs?metadata_chat=${chat}&metadata_role=condenser&limit=100`))
        .logs ?? []
    ).filter((log) => log.metadata.role === 'condenser')
    return logs.length >= 1
  }, 15_000)
  return logs
}
const condensationsOf = (chat: ChatId) =>
  database.$client`
    select payload->'event' as event, payload->'delegation'->>'id' as delegation from events
    where chat_id = ${chat} and payload->'event'->>'kind' = 'Condensation' order by seq`
const commandOf = (call: object) => JSON.parse((call as { function: { arguments: string } }).function.arguments).command
const expectMaskedInBatches = (requests: { request: Request }[], commands: { command: string }[]) => {
  expect(requests.length).toBeGreaterThan(5)
  for (const { request } of requests) {
    const outputs = outputsOf(request)
    const cutoff = outputs.length >= 3 ? Math.floor((outputs.length - 1) / 2) * 2 : 0
    expect(outputs.map(isCleared)).toEqual(outputs.map((_, index) => index < cutoff))
    expect(callsOf(request).map(commandOf)).toEqual(commands.slice(0, outputs.length).map(({ command }) => command))
  }
}

test.skipIf(!hasImage)(
  'a long conversation sends old outputs masked with the calls intact, each request extends the previous one until a batch moves, and past the event limit the condenser runs on the cheapest model and its summary comes back',
  async () => {
    const chat = await newRuntimeChat()
    const start = fakeLlmBodies.length
    const summary = 'Summary of the earlier listings.'
    const commands = longCommands(12)
    setFakeLlmScript({ steps: commands, text: 'Listed.', summary, wordDelayMilliseconds: 1 })
    await promptAndAnswer(chat, 'List the long ranges')
    const firstTurn = agentRequestsSince(start, 'List the long ranges')
    expect(firstTurn).toHaveLength(13)
    expectMaskedInBatches(firstTurn, commands)
    let extended = 0
    let moved = 0
    for (const [index, { request }] of firstTurn.entries()) {
      const previous = firstTurn[index - 1]?.request
      if (!previous) continue
      const isPrefix = Bun.deepEquals(request.messages.slice(0, previous.messages.length), previous.messages)
      const hasMoved = outputsOf(request).filter(isCleared).length > outputsOf(previous).filter(isCleared).length
      expect(isPrefix || hasMoved).toBe(true)
      if (isPrefix) extended++
      if (hasMoved) moved++
    }
    expect(extended).toBeGreaterThan(2)
    expect(moved).toBeGreaterThan(2)
    expect(await condensationsOf(chat)).toHaveLength(0)

    setFakeLlmScript({ steps: longCommands(12, 20), text: 'Listed again.', summary, wordDelayMilliseconds: 1 })
    await promptAndAnswer(chat, 'List more ranges')
    const [condensation] = await condensationsOf(chat)
    expect(condensation?.event).toMatchObject({ kind: 'Condensation', summary, summary_offset: 2 })
    const [log] = await condenserLogsOf(chat)
    expect(log).toMatchObject({ model: 'fake-small', metadata: { role: 'condenser', prompter: alice, owner: alice } })
    const afterCondensation = agentRequestsSince(start, 'List the long ranges').at(-1)?.request
    expect(
      afterCondensation?.messages.some(
        (message) => message.role === 'user' && JSON.stringify(message.content).includes(summary),
      ),
    ).toBe(true)
    const replies = await database.$client`
      select kind, body from messages where chat_id = ${chat} and kind = 'notice' order by seq`
    expect(replies.map(({ kind, body }) => ({ kind, body }))).toEqual([
      { kind: 'notice', body: 'Context condensed · earlier steps summarized' },
    ])
  },
)

test.skipIf(!hasImage)(
  "a subagent's requests are masked the same way and its condenser call is attributed to its delegation",
  async () => {
    const chat = await newRuntimeChat()
    const start = fakeLlmBodies.length
    const task = 'List every long range'
    const subagentCommands = longCommands(24)
    const script: FakeLlmScript = {
      steps: [{ tool: 'delegate', arguments: { task, effort: 'small' } }],
      text: 'Main done.',
      summary: 'Summary of the subagent listings.',
      delegateRoute: { tier: 'small', confidence: 'high', effort: 'low' },
      subagents: { 'fake-small': { steps: subagentCommands, text: 'Sub done.', wordDelayMilliseconds: 1 } },
      wordDelayMilliseconds: 1,
    }
    setFakeLlmScript(script)
    await promptAndAnswer(chat, 'Delegate the long listing')
    const [delegation] = await database.$client`select id from delegations where chat_id = ${chat}`
    const subRequests = agentRequestsSince(start, task)
    expectMaskedInBatches(
      subRequests.filter(({ request }) => !JSON.stringify(request).includes(String(script.summary))),
      subagentCommands,
    )
    const [condensation] = await condensationsOf(chat)
    expect(condensation).toMatchObject({ delegation: delegation?.id })
    const [log] = await condenserLogsOf(chat)
    expect(log).toMatchObject({
      model: 'fake-small',
      metadata: { role: 'condenser', delegation: delegation?.id, prompter: alice },
    })
  },
)

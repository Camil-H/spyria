import { afterAll, expect, setDefaultTimeout, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSandboxAgentServer } from '@hq/conversation/server'
import { testGatewayAdmin } from '@hq/db/testing'
import { schema } from '@hq/db/zero'
import { runtimeHostId } from '@hq/kernel'
import { createBifrostUsageLogs, syncUsageNow } from '@hq/usage/server'
import { zeroDrizzle } from '@rocicorp/zero/server/adapters/drizzle'
import { websocket } from 'hono/bun'
import { createApp } from '../app.ts'
import { readHqAgentImage } from '../hq-agent-image.ts'
import { createModelCallRelay } from '../llm-relay.ts'
import { createRuntimeHostGateway } from '../runtime-hosts/gateway.ts'
import {
  acme,
  addLlmKey,
  alice,
  aliceInAcme,
  gatewayLogsOf,
  openSharedTestApp,
  runtimeTurn,
  bob,
  sessionTokenOf,
  testAuthSettings,
  waitFor,
} from '../testing.ts'
import { createAgentBridge } from './bridge.ts'

setDefaultTimeout(180_000)
const docker = (...args: string[]) => Bun.spawnSync(['docker', ...args], { stderr: 'pipe' })
const hqImage = await readHqAgentImage()
if (!hqImage || docker('image', 'inspect', hqImage).exitCode !== 0)
  throw new Error('HQ image missing: run bun run agent:build')

const { database, gateway, llmGateway } = await openSharedTestApp()
const runtimeHosts = createRuntimeHostGateway({
  databases: () => [database],
  hqAgentImage: hqImage,
  relayModelCall: createModelCallRelay({ llmGateway, agentBridge: () => agentBridge }),
})
const agentBridge = createAgentBridge({ sandboxProvider: runtimeHosts.sandboxProvider, hqAgentImage: hqImage })
const app = createApp({ database, ...testAuthSettings, llmGateway, runtimeHosts, agentBridge })
const server = Bun.serve({ port: 0, fetch: app.fetch, websocket })
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
  hostProcess = Bun.spawn(['bun', hostProgram, '--personal', `http://localhost:${server.port}/h/${code}`], {
    env: { ...process.env, HQ_HOST_STATE_DIR: stateDirectory, HQ_HOST_PREFIX: prefix },
    stdout: 'inherit',
    stderr: 'inherit',
  })
  await waitFor(
    async () => (await database.$client`select status from runtime_hosts where id = ${id}`)[0]?.status === 'online',
    30_000,
  )
  return id
}

test("Pi in HQ's image answers through the LLM relay on the chat and Anthropic routes, streams its text to the events socket, ends the turn and each call is attributed to the prompter and the owner", async () => {
  await addLlmKey(bob, 'Fake')
  await addLlmKey(bob, 'Anthropic')
  const id = await startHost()
  const host = { workspaceId: acme, hostId: runtimeHostId(id) }
  await runtimeHosts.prepare(host, hqImage)
  const runtime = { ...host, runtimeId: 'pi-smoke' }
  const apiKey = 'test-api-key-0123456789abcdef'
  await runtimeHosts.sandboxProvider.create({ ...runtime, image: hqImage, apiKey })
  await runtimeHosts.sandboxProvider.start(runtime)
  const transport = runtimeHosts.sandboxProvider.connect(runtime)
  const isReady = () =>
    transport.fetch({ method: 'GET', path: '/ready', timeoutMilliseconds: 1000 }).then(
      (response) => response.status === 200,
      () => false,
    )
  await waitFor(isReady, 30_000)

  const { chatId, token } = await runtimeTurn({ id }, bob)
  const agentServer = createSandboxAgentServer()
  const endpoint = { transport, apiKey, conversationId: null, isHqAgent: true }
  const conversationId = await agentServer.createConversation(endpoint, token, {
    model: '',
    usageId: 'agent',
    acpModel: 'hq/fake/fake-medium',
    pi: {
      models: [
        { id: 'fake/fake-medium', name: 'Fake medium', reasoning: false },
        { id: 'anthropic/claude-haiku-4-5', name: 'Haiku 4.5', reasoning: false, contextWindow: 200000 },
      ],
      compactionModel: 'fake/fake-small',
    },
  })
  const conversation = { ...endpoint, conversationId }
  const updates: { sessionUpdate?: string; stopReason?: string; content?: { text?: string } }[] = []
  const socket = agentServer.openEvents(conversation, null, {
    onEvent: (event) => updates.push((event as { update?: (typeof updates)[number] }).update ?? {}),
    onClose: () => {},
  })
  const turnEnds = () => updates.filter((update) => update.sessionUpdate === 'turn_end')
  const answerOf = async (text: string, turn: number) => {
    const start = updates.length
    await agentServer.sendMessage(conversation, text)
    await waitFor(() => turnEnds().length >= turn, 120_000)
    return updates
      .slice(start)
      .filter((update) => update.sessionUpdate === 'agent_message_chunk')
      .map((update) => update.content?.text ?? '')
      .join('')
  }
  expect(await answerOf('Hello Pi', 1)).toBe('Understood, working on it.')
  await agentServer.switchAcpModel(conversation, 'hq-anthropic/anthropic/claude-haiku-4-5')
  expect(await answerOf('Hello Pi on Anthropic', 2)).toContain('Understood')
  expect(turnEnds().map((update) => update.stopReason)).toEqual(['end_turn', 'end_turn'])
  socket.close()

  await gatewayLogsOf(gateway, `metadata_chat=${chatId}`, 2)
  const usageLogs = createBifrostUsageLogs({
    url: gateway.url,
    adminUser: testGatewayAdmin.user,
    adminPassword: testGatewayAdmin.password,
    labels: { chat: chatId },
  })
  const zeroDatabase = zeroDrizzle(schema, database)
  await syncUsageNow(usageLogs, { workspaceId: acme, transact: (work) => zeroDatabase.transaction(work) })
  const calls = await database.$client`
    select prompter_id, owner_id, model, provider, status from model_calls where chat_id = ${chatId}`
  expect(new Set(calls.map((call) => JSON.stringify(call)))).toEqual(
    new Set([
      JSON.stringify({ prompter_id: bob, owner_id: alice, model: 'fake-medium', provider: 'fake', status: 'success' }),
      JSON.stringify({
        prompter_id: bob,
        owner_id: alice,
        model: 'claude-haiku-4-5',
        provider: 'anthropic',
        status: 'success',
      }),
    ]),
  )
})

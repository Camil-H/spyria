import { afterAll, afterEach, expect, setDefaultTimeout, test } from 'bun:test'
import { defaultHarness } from '@spyria/kernel'
import { websocket } from 'hono/bun'
import { createAgentBridge } from './agent-bridge/bridge.ts'
import { createApp } from './app.ts'
import { startJobWorker } from './job-worker.ts'
import { createModelCallRelay } from './llm-relay.ts'
import { createRuntimeHostGateway } from './runtime-hosts/gateway.ts'
import {
  acme,
  addLlmKey,
  alice,
  bob,
  captureConsole,
  captureLogs,
  createFakeHosts,
  type FakeHost,
  gatewayLogsOf,
  lee,
  mcpCall,
  openSharedTestApp,
  rpcOf,
  runtimeTurn,
  succeeded,
  testAuthSettings,
  testSecretsKeyring,
  virtualKeyOf,
  waitFor,
} from './testing/testing.ts'

setDefaultTimeout(30_000)
const { database, port, gateway, llmGateway, fakeLlmCalls, fakeLlmBodies, resultOf } = await openSharedTestApp()
const { fakeHost, disconnectFakeHosts } = createFakeHosts({ port, database })
const worker = startJobWorker(database, { pollIntervalMilliseconds: 5, llmGateway })
afterEach(() => disconnectFakeHosts())
afterAll(async () => {
  await disconnectFakeHosts()
  await worker.stop()
})

const bobSecret = `fake-key-bob-${crypto.randomUUID()}`
const completion = JSON.stringify({
  model: 'mistral/codestral-latest',
  stream: true,
  messages: [{ role: 'user', content: 'hi' }],
})
const failureOf = async (chatId: string) =>
  (await database.$client`select agent_turn_failure from chats where id = ${chatId}`)[0]?.agent_turn_failure
const credentialIdsOf = async (userId: string) =>
  (
    await database.$client<{ id: string }[]>`
      select id from llm_credentials where workspace_id = ${acme} and user_id = ${userId}`
  ).map(({ id }) => id)
const providerKeyIdsOf = async (userId: string) =>
  ((await virtualKeyOf(userId)).provider_configs ?? [])
    .flatMap((config) => config.keys.map((key) => key.key_id))
    .toSorted()
const removeCredentials = async (userId: string, credentialIds: string[]) => {
  for (const credentialId of credentialIds)
    expect(
      await resultOf({ workspaceId: acme, userId }, 'profile.removeLlmCredential', { workspaceId: acme, credentialId }),
    ).toEqual(succeeded)
}
const withLlmKey = async (userId: string, provider: string, secret: string, work: () => Promise<void>) => {
  const credentialsBefore = await credentialIdsOf(userId)
  const providerKeysBefore = await providerKeyIdsOf(userId)
  await addLlmKey(userId, provider, secret)
  try {
    await work()
  } finally {
    await removeCredentials(
      userId,
      (await credentialIdsOf(userId)).filter((id) => !credentialsBefore.includes(id)),
    )
    await waitFor(async () => Bun.deepEquals(await providerKeyIdsOf(userId), providerKeysBefore))
  }
}
await addLlmKey(bob, 'Mistral', bobSecret)

test('a relayed call runs on the turn prompter’s virtual key with Spyria’s attribution, streams back, and drops spoofed auth and x-bf headers', async () => {
  const host = await fakeHost('Relay host')
  const { chatId, token, promptId } = await runtimeTurn(host, bob)
  const sessionId = `conversation-${crypto.randomUUID()}`
  await database.$client`update runtimes set agent_conversation_id = ${sessionId} where chat_id = ${chatId}`
  const bobKey = await virtualKeyOf(bob)
  const consoleCalls = captureConsole()
  const callsBefore = fakeLlmCalls.length
  let answer: Awaited<ReturnType<FakeHost['modelCall']>>
  try {
    answer = await host.modelCall({
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'x-bf-dim-prompter': 'member-mallory',
        'x-bf-eh-x-spoofed': 'yes',
        'x-bf-vk': 'sk-bf-not-mine',
        'x-api-key': 'stolen',
      },
      body: completion,
    })
  } finally {
    consoleCalls.restore()
  }
  expect(answer).toMatchObject({ status: 200, ended: 'gw_end' })
  expect(answer.body).toContain('Understood,')
  expect(answer.body).toContain('data: [DONE]')
  const [providerCall] = fakeLlmCalls.slice(callsBefore)
  expect(providerCall?.authorization).toBe(`Bearer ${bobSecret}`)
  expect(Object.keys(providerCall ?? {}).filter((name) => /spoofed|x-bf|x-api-key/.test(name))).toEqual([])
  expect((await gatewayLogsOf(gateway, `virtual_key_ids=${bobKey.id}`))[0]?.metadata).toEqual({
    chat: chatId,
    prompter: bob,
    owner: alice,
    workspace: acme,
    turn: promptId,
    session: sessionId,
  })
  const everyFrame = host.receivedFrames.join('\n')
  const logged = consoleCalls.logged()
  for (const secret of [bobSecret, bobKey.value]) {
    expect(everyFrame).not.toContain(secret)
    expect(logged).not.toContain(secret)
  }
  expect(await failureOf(chatId)).toBeNull()
})

test('an OpenRouter key relays openrouter/anthropic/claude-sonnet-5.5 to its provider with the provider’s model id, recorded with prompter and owner', async () => {
  const providerModel = 'anthropic/claude-sonnet-5.5'
  const secret = `fake-key-OpenRouter-${crypto.randomUUID()}`
  await withLlmKey(bob, 'OpenRouter', secret, async () => {
    const host = await fakeHost('Relay host')
    const { chatId, token } = await runtimeTurn(host, bob)
    const callsBefore = fakeLlmCalls.length
    const answer = await host.modelCall({
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: `openrouter/${providerModel}`,
        stream: true,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    })
    expect(answer).toMatchObject({ status: 200, ended: 'gw_end' })
    expect(answer.body).toContain('data: [DONE]')
    const posted = fakeLlmBodies.flatMap((body, index) => (index >= callsBefore && body ? [index] : []))
    expect(posted.map((index) => fakeLlmCalls[index]?.authorization)).toEqual([`Bearer ${secret}`])
    expect(posted.map((index) => JSON.parse(fakeLlmBodies[index] ?? '{}').model)).toEqual([providerModel])
    const [log] = await gatewayLogsOf(gateway, `metadata_chat=${chatId}`)
    expect(log?.model).toBe(providerModel)
    expect(log?.metadata).toMatchObject({ chat: chatId, prompter: bob, owner: alice })
  })
})

test('a model call sent right after the host’s hello is relayed once the hello is recorded', async () => {
  const host = await fakeHost('Reconnecting host')
  const { token } = await runtimeTurn(host, bob)
  await host.disconnect()
  let answer: ReturnType<FakeHost['modelCall']> | undefined
  await host.connect({
    afterHello: () => {
      answer = host.modelCall({ headers: { authorization: `Bearer ${token}` }, body: completion })
    },
  })
  expect(await answer).toMatchObject({ status: 200, ended: 'gw_end' })
})

test('calls outside /v1, without an active turn or with another host’s runtime token are refused before the gateway', async () => {
  const host = await fakeHost('Turn host')
  const otherHost = await fakeHost('Other host')
  const { chatId, token } = await runtimeTurn(host, bob)
  const callsBefore = fakeLlmCalls.length
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }

  expect(await host.modelCall({ path: '/api/providers', headers })).toMatchObject({ status: 404 })
  for (const path of [
    '/v1/../api/providers',
    '/v1/%2e%2e/api/providers',
    '/v1/%2E%2E/api/providers',
    '/v1/..%2fapi/providers',
    '/v1\\..\\api/providers',
    '/mcp/../api/providers',
  ])
    expect(await host.modelCall({ path, headers, body: completion })).toMatchObject({
      status: 404,
      body: expect.stringContaining('"type":"not_found"'),
    })
  expect(await otherHost.modelCall({ headers, body: completion })).toMatchObject({ status: 401 })
  expect(await host.modelCall({ headers: { authorization: 'Bearer unknown' }, body: completion })).toMatchObject({
    status: 401,
  })
  await database.$client`update chats set agent_turn_message_id = null, agent_turn_prompter_id = null where id = ${chatId}`
  const outsideTurn = await host.modelCall({ headers, body: completion })
  expect(outsideTurn.status).toBe(401)
  expect(outsideTurn.body).not.toContain('sk-')
  expect(fakeLlmCalls.length).toBe(callsBefore)
})

test('a machine session’s runtime token is refused for model calls before the gateway', async () => {
  const host = await fakeHost('Local session host')
  const { chatId, token } = await runtimeTurn(host, alice)
  await database.$client`update chats set local_session = true, harness = ${defaultHarness} where id = ${chatId}`
  const callsBefore = fakeLlmCalls.length
  const headers = { 'x-api-key': token, 'content-type': 'application/json' }
  expect(await host.modelCall({ path: '/v1/messages', headers, body: completion })).toMatchObject({ status: 401 })
  expect(await host.modelCall({ headers, body: completion })).toMatchObject({ status: 401 })
  expect(fakeLlmCalls.length).toBe(callsBefore)
})

test('a prompter without a gateway key is refused and Spyria’s notice is recorded on the turn', async () => {
  const host = await fakeHost('No key host')
  const { chatId, token } = await runtimeTurn(host, alice)
  const removedGatewayKeys = await database.$client<
    { workspace_id: string; user_id: string; virtual_key_id: string | null; virtual_key_name: string }[]
  >`
    delete from member_gateway_keys where user_id = ${alice}
    returning workspace_id, user_id, virtual_key_id, virtual_key_name`
  try {
    const refused = await host.modelCall({ headers: { authorization: `Bearer ${token}` }, body: completion })
    expect(refused.status).toBe(401)
    expect(await failureOf(chatId)).toBe('Alice has no LLM key in this workspace')
  } finally {
    for (const key of removedGatewayKeys)
      await database.$client`
        insert into member_gateway_keys (workspace_id, user_id, virtual_key_id, virtual_key_name)
        values (${key.workspace_id}, ${key.user_id}, ${key.virtual_key_id}, ${key.virtual_key_name})`
  }
})

test('a prompter whose gateway key serves only tools, with no LLM key, is refused before the gateway', async () => {
  const host = await fakeHost('Tools-only key host')
  await database.$client`delete from llm_credentials where workspace_id = ${acme} and user_id = ${lee}`
  const { chatId, token } = await runtimeTurn(host, lee, lee)
  const initialized = await mcpCall(
    host,
    token,
    rpcOf('initialize', { protocolVersion: '2025-06-18', capabilities: {} }),
  )
  expect(initialized.status).toBe(200)
  expect(await database.$client`select 1 from member_gateway_keys where user_id = ${lee}`).toHaveLength(1)
  const callsBefore = fakeLlmCalls.length
  const refused = await host.modelCall({ headers: { authorization: `Bearer ${token}` }, body: completion })
  expect(refused.status).toBe(401)
  expect(await failureOf(chatId)).toBe('Lee has no LLM key in this workspace')
  expect(fakeLlmCalls.length).toBe(callsBefore)
})

test('a key the provider refuses is classified on the turn without provider text', async () => {
  const host = await fakeHost('Refused key host')
  await removeCredentials(alice, await credentialIdsOf(alice))
  await waitFor(async () => (await providerKeyIdsOf(alice)).length === 0)
  await withLlmKey(alice, 'Mistral', `fake-refused-${crypto.randomUUID()}`, async () => {
    const { chatId, token } = await runtimeTurn(host, alice)
    const refused = await host.modelCall({ headers: { authorization: `Bearer ${token}` }, body: completion })
    expect(refused.status).toBe(401)
    expect(await failureOf(chatId)).toBe('The LLM key of Alice was refused')
  })
})

test('a call with tools sets the chat’s context size and a call without tools, such as a compaction summary, leaves it', async () => {
  const host = await fakeHost('Context host')
  const { chatId, token } = await runtimeTurn(host, bob)
  const contextTokensOf = async () =>
    (await database.$client`select context_tokens from chats where id = ${chatId}`)[0]?.context_tokens
  const logs = captureLogs()
  const relayedCallCount = () =>
    logs.events.filter((logged) => logged.event === 'gen_ai.call' && logged.attributes?.['chat.id'] === chatId).length
  const relayed = async (body: object) => {
    const callsBefore = relayedCallCount()
    const answer = await host.modelCall({
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ ...JSON.parse(completion), ...body }),
    })
    await waitFor(() => relayedCallCount() > callsBefore)
    return answer
  }
  try {
    expect(await relayed({ tools: [{ type: 'function', function: { name: 'bash', parameters: {} } }] })).toMatchObject({
      status: 200,
    })
    expect(await contextTokensOf()).toBe(2)
    await database.$client`update chats set context_tokens = 7 where id = ${chatId}`
    expect(
      await relayed({ messages: [{ role: 'user', content: 'Summarize the whole earlier conversation, please.' }] }),
    ).toMatchObject({ status: 200 })
    expect(await contextTokensOf()).toBe(7)
  } finally {
    logs.restore()
  }
})

test('a context-window rejection reaches the agent unchanged and records no turn failure, so the agent can compact', async () => {
  const host = await fakeHost('Too long host')
  const { chatId, token } = await runtimeTurn(host, bob)
  const tooLong = await host.modelCall({
    headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify({ ...JSON.parse(completion), messages: [{ role: 'user', content: '$too-long' }] }),
  })
  expect(tooLong.status).toBe(400)
  expect(tooLong.body).toContain('prompt is too long')
  expect(await failureOf(chatId)).toBeNull()
})

test('a model call is retried once when the gateway refuses the connection, then answers 502 with Spyria’s notice recorded, and never once the gateway has answered', async () => {
  let nextGatewayUrls: string[] = []
  const failingGatewayCalls: string[] = []
  const failingGateway = Bun.serve({
    port: 0,
    fetch: (request) => {
      failingGatewayCalls.push(new URL(request.url).pathname)
      return Response.json({ error: { message: 'overloaded' } }, { status: 503 })
    },
  })
  const runtimeHosts = createRuntimeHostGateway({
    secretsKeyring: testSecretsKeyring,
    databases: () => [database],
    relayModelCall: createModelCallRelay({
      llmGateway,
      gatewayUrlOf: () => nextGatewayUrls.shift() ?? llmGateway.url,
      agentBridge: () => agentBridge,
    }),
  })
  const agentBridge = createAgentBridge({ sandboxProvider: runtimeHosts.sandboxProvider })
  const relayApp = createApp({ database, ...testAuthSettings, llmGateway, runtimeHosts, agentBridge })
  const server = Bun.serve({ port: 0, fetch: relayApp.fetch, websocket })
  const hosts = createFakeHosts({ port: Number(server.port), database })
  try {
    const host = await hosts.fakeHost('Retrying gateway host')
    const { chatId, token } = await runtimeTurn(host, bob)
    const call = () => host.modelCall({ headers: { authorization: `Bearer ${token}` }, body: completion })
    nextGatewayUrls = ['http://127.0.0.1:9']
    expect(await call()).toMatchObject({ status: 200, ended: 'gw_end' })
    expect(await failureOf(chatId)).toBeNull()
    nextGatewayUrls = ['http://127.0.0.1:9', 'http://127.0.0.1:9', 'http://127.0.0.1:9']
    const unreachable = await call()
    expect(unreachable.status).toBe(502)
    expect(unreachable.body).toContain('The model gateway is unreachable')
    expect(await failureOf(chatId)).toBe('The model gateway is unreachable')
    expect(nextGatewayUrls).toHaveLength(1)
    nextGatewayUrls = [failingGateway.url.origin, failingGateway.url.origin]
    expect((await call()).status).toBe(503)
    expect(failingGatewayCalls).toEqual(['/v1/chat/completions'])
  } finally {
    await hosts.disconnectFakeHosts()
    void server.stop(true)
    void failingGateway.stop(true)
  }
})

test('a Pi call with x-api-key on the Anthropic route goes to the gateway’s Anthropic route with its protocol headers', async () => {
  const host = await fakeHost('Anthropic route host')
  const anthropicSecret = `fake-key-anthropic-${crypto.randomUUID()}`
  await withLlmKey(bob, 'Anthropic', anthropicSecret, async () => {
    const { chatId, token } = await runtimeTurn(host, bob)
    const headers = {
      'x-api-key': token,
      'content-type': 'application/json',
      'anthropic-version': '2023-06-01',
    }
    const message = {
      model: 'anthropic/claude-opus-5-5',
      max_tokens: 64,
      messages: [{ role: 'user', content: 'hi' }],
    }
    for (const attempt of [1, 2, 3]) {
      const callsBefore = fakeLlmCalls.length
      const answer = await host.modelCall({
        path: '/v1/messages?beta=true',
        headers,
        body: JSON.stringify({ ...message, stream: true }),
      })
      expect({ attempt, status: answer.status }).toEqual({ attempt, status: 200 })
      expect(answer.body).toContain('event: message_stop')
      const providerCall = fakeLlmCalls[callsBefore]
      expect(providerCall?.['x-api-key']).toBe(anthropicSecret)
      expect(providerCall?.['anthropic-version']).toBe('2023-06-01')
      expect(JSON.parse(fakeLlmBodies[callsBefore] ?? '{}').model).toBe('claude-opus-5-5')
    }
    const counted = await host.modelCall({
      path: '/v1/messages/count_tokens?beta=true',
      headers,
      body: JSON.stringify(message),
    })
    expect(counted).toMatchObject({ status: 200, body: JSON.stringify({ input_tokens: 1 }) })
    expect(await failureOf(chatId)).toBeNull()
  })
})

test('a failing Anthropic token count reaches the agent unchanged and records no turn failure', async () => {
  const host = await fakeHost('Token count host')
  await withLlmKey(bob, 'Anthropic', `fake-key-anthropic-${crypto.randomUUID()}`, async () => {
    const { chatId, token } = await runtimeTurn(host, bob)
    const counted = await host.modelCall({
      path: '/v1/messages/count_tokens?beta=true',
      headers: { 'x-api-key': token, 'content-type': 'application/json', 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'anthropic/claude-opus-5-5',
        messages: [{ role: 'user', content: '$count-fails' }],
      }),
    })
    expect(counted.status).toBeGreaterThanOrEqual(400)
    expect(await failureOf(chatId)).toBeNull()
  })
})

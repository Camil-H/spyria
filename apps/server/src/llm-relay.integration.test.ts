import { afterAll, afterEach, expect, setDefaultTimeout, test } from 'bun:test'
import { websocket } from 'hono/bun'
import { createApp } from './app.ts'
import {
  acme,
  addLlmKey,
  alice,
  captureConsole,
  createFakeHosts,
  type FakeHost,
  gatewayLogsOf,
  llmGatewayAt,
  openSharedTestApp,
  runtimeTurn,
  bob,
  testAuthSettings,
  virtualKeyOf,
} from './testing/testing.ts'

setDefaultTimeout(30_000)
const { database, port, gateway, fakeLlmCalls, fakeLlmBodies } = await openSharedTestApp()
const { fakeHost, disconnectFakeHosts } = createFakeHosts({ port, database })
afterEach(() => disconnectFakeHosts())

const bobSecret = `fake-key-bob-${crypto.randomUUID()}`
const completion = JSON.stringify({
  model: 'fake/fake-model',
  stream: true,
  messages: [{ role: 'user', content: 'hi' }],
})
const failureOf = async (chatId: string) =>
  (await database.$client`select agent_turn_failure from chats where id = ${chatId}`)[0]?.agent_turn_failure
await addLlmKey(bob, 'Fake', bobSecret)

test('a relayed call runs on the turn prompter’s virtual key with HQ’s attribution, streams back, and drops spoofed auth and x-bf headers', async () => {
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

test.each([
  ['OpenRouter', 'openrouter/anthropic/claude-sonnet-5.5', 'anthropic/claude-sonnet-5.5'],
  ['xAI', 'xai/grok-4.3', 'grok-4.3'],
  ['DeepSeek', 'deepseek/deepseek-v4-flash', 'deepseek-v4-flash'],
  ['Z.ai', 'zai/glm-4.7', 'glm-4.7'],
])(
  'a %s key relays %s to its provider with the provider’s model id, recorded with prompter and owner',
  async (provider, model, providerModel) => {
    const secret = `fake-key-${provider}-${crypto.randomUUID()}`
    await addLlmKey(bob, provider, secret)
    const host = await fakeHost('Relay host')
    const { chatId, token } = await runtimeTurn(host, bob)
    const callsBefore = fakeLlmCalls.length
    const answer = await host.modelCall({
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model, stream: true, messages: [{ role: 'user', content: 'hi' }] }),
    })
    expect(answer).toMatchObject({ status: 200, ended: 'gw_end' })
    expect(answer.body).toContain('data: [DONE]')
    const posted = fakeLlmBodies.flatMap((body, index) => (index >= callsBefore && body ? [index] : []))
    expect(posted.map((index) => fakeLlmCalls[index]?.authorization)).toEqual([`Bearer ${secret}`])
    expect(posted.map((index) => JSON.parse(fakeLlmBodies[index] ?? '{}').model)).toEqual([providerModel])
    const [log] = await gatewayLogsOf(gateway, `metadata_chat=${chatId}`)
    expect(log?.model).toBe(providerModel)
    expect(log?.metadata).toMatchObject({ chat: chatId, prompter: bob, owner: alice })
  },
)

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
  await database.$client`update chats set local_session = true, harness = 'claude-code' where id = ${chatId}`
  const callsBefore = fakeLlmCalls.length
  const headers = { 'x-api-key': token, 'content-type': 'application/json' }
  expect(await host.modelCall({ path: '/v1/messages', headers, body: completion })).toMatchObject({ status: 401 })
  expect(await host.modelCall({ headers, body: completion })).toMatchObject({ status: 401 })
  expect(fakeLlmCalls.length).toBe(callsBefore)
})

test('a prompter without a gateway key is refused and HQ’s notice is recorded on the turn', async () => {
  const host = await fakeHost('No key host')
  const { chatId, token } = await runtimeTurn(host, alice)
  await database.$client`delete from member_gateway_keys where user_id = ${alice}`
  const refused = await host.modelCall({ headers: { authorization: `Bearer ${token}` }, body: completion })
  expect(refused.status).toBe(401)
  expect(await failureOf(chatId)).toBe('Alice has no LLM key in this workspace')
})

test('a key the provider refuses is classified on the turn without provider text', async () => {
  const host = await fakeHost('Refused key host')
  await database.$client`delete from llm_credentials where user_id = ${alice}`
  await addLlmKey(alice, 'Fake', `fake-refused-${crypto.randomUUID()}`)
  const { chatId, token } = await runtimeTurn(host, alice)
  const refused = await host.modelCall({ headers: { authorization: `Bearer ${token}` }, body: completion })
  expect(refused.status).toBe(401)
  expect(await failureOf(chatId)).toBe('The LLM key of Alice was refused')
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

test('an unreachable gateway answers 502 and records HQ’s notice', async () => {
  const unreachableApp = createApp({ database, ...testAuthSettings, llmGateway: llmGatewayAt('http://127.0.0.1:9') })
  const server = Bun.serve({ port: 0, fetch: unreachableApp.fetch, websocket })
  const hosts = createFakeHosts({ port: Number(server.port), database })
  try {
    const host = await hosts.fakeHost('Unreachable gateway host')
    const { chatId, token } = await runtimeTurn(host, bob)
    const answer = await host.modelCall({ headers: { authorization: `Bearer ${token}` }, body: completion })
    expect(answer.status).toBe(502)
    expect(answer.body).toContain('The model gateway is unreachable')
    expect(await failureOf(chatId)).toBe('The model gateway is unreachable')
  } finally {
    await hosts.disconnectFakeHosts()
    void server.stop(true)
  }
})

test('a Pi call with x-api-key on the Anthropic route goes to the gateway’s Anthropic route with its protocol headers', async () => {
  const host = await fakeHost('Anthropic route host')
  const anthropicSecret = `fake-key-anthropic-${crypto.randomUUID()}`
  await addLlmKey(bob, 'Anthropic', anthropicSecret)
  const { chatId, token } = await runtimeTurn(host, bob)
  const headers = {
    'x-api-key': token,
    'content-type': 'application/json',
    'anthropic-version': '2023-06-01',
  }
  const message = { model: 'anthropic/claude-opus-5-5', max_tokens: 64, messages: [{ role: 'user', content: 'hi' }] }
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

test('a failing Anthropic token count reaches the agent unchanged and records no turn failure', async () => {
  const host = await fakeHost('Token count host')
  const { chatId, token } = await runtimeTurn(host, bob)
  const counted = await host.modelCall({
    path: '/v1/messages/count_tokens?beta=true',
    headers: { 'x-api-key': token, 'content-type': 'application/json', 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'anthropic/claude-opus-5-5', messages: [{ role: 'user', content: '$count-fails' }] }),
  })
  expect(counted.status).toBeGreaterThanOrEqual(400)
  expect(await failureOf(chatId)).toBeNull()
})

afterAll(() => disconnectFakeHosts())

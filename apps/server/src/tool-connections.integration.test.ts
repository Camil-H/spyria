import { afterAll, afterEach, beforeEach, expect, setDefaultTimeout, spyOn, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { agentServerImage } from '@hq/runtime/server'
import { websocket } from 'hono/bun'
import { createAgentBridge } from './agent-bridge/bridge.ts'
import { createApp, defaultLlm } from './app.ts'
import { createModelCallRelay } from './llm-relay.ts'
import { createRuntimeHostGateway } from './runtime-hosts/gateway.ts'
import {
  acme,
  alice,
  createFakeHosts,
  type FakeHost,
  openSharedTestApp,
  bob,
  sessionTokenOf,
  testAuthSettings,
  waitFor,
} from './testing.ts'

setDefaultTimeout(30_000)
const { database, app, port, gateway, llmGateway, fakeMcp } = await openSharedTestApp()
const { fakeHost, disconnectFakeHosts } = createFakeHosts({ port, database })
afterEach(() => disconnectFakeHosts())
afterAll(() => disconnectFakeHosts())

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex')
const aliceAccount = `alice-${crypto.randomUUID().slice(0, 8)}`
const aliceCookie = `fake_mcp_user=${aliceAccount}`

const asMember = async (userId: string, method: string, path: string) => {
  const response = await app.request(path, {
    method,
    headers: { authorization: `Bearer ${await sessionTokenOf(database, acme, userId)}` },
  })
  return { status: response.status, body: await response.text() }
}
const connectionPath = (action: string) => `/api/tool-connections/fake/${action}`
beforeEach(() => asMember(alice, 'POST', connectionPath('disconnect')))
const consentThroughHq = async (authorizeUrl: string, cookie = aliceCookie) => {
  const authorized = await fetch(authorizeUrl, { redirect: 'manual', headers: { cookie } })
  const callback = new URL(authorized.headers.get('location') ?? '')
  const page = await app.request(`${callback.pathname}${callback.search}`)
  return { callbackPath: callback.pathname, status: page.status, page: await page.text() }
}
const connectAlice = async () => {
  const started = await asMember(alice, 'POST', connectionPath('connect'))
  expect(started.status).toBe(200)
  const consent = await consentThroughHq(JSON.parse(started.body).authorizeUrl)
  expect(consent.page).toContain('"connected":true')
  expect(await asMember(alice, 'POST', connectionPath('refresh'))).toEqual({
    status: 200,
    body: JSON.stringify({ status: 'Connected' }),
  })
}
const virtualKeyOf = async (userId: string) => {
  const [row] = await database.$client`select virtual_key_id from member_gateway_keys where user_id = ${userId}`
  return (
    await gateway.call<{
      virtual_key: {
        id: string
        value: string
        mcp_configs: { mcp_client: { name: string } }[]
        provider_configs: { keys: unknown[] }[]
      }
    }>(`/api/governance/virtual-keys/${row?.virtual_key_id}`)
  ).virtual_key
}
const fakeClientId = async () =>
  (await gateway.call<{ clients: { config: { client_id: string; name: string } }[] }>('/api/mcp/clients')).clients.find(
    (client) => client.config.name === 'fake',
  )?.config.client_id
const sessionsOf = async (virtualKeyId: string) =>
  (
    await gateway.call<{ sessions: { status: string }[] }>(
      `/api/mcp/sessions?virtual_key_id=${virtualKeyId}&mcp_client_id=${await fakeClientId()}`,
    )
  ).sessions
const connectionRows = async () => [
  ...(await database.$client`select user_id, tool, status from tool_connections where tool = 'fake'`),
]

const runtimeChat = async (host: FakeHost, prompterId: string | null) => {
  const chatId = `chat-${crypto.randomUUID()}`
  const promptId = `message-${crypto.randomUUID()}`
  const token = `runtime-token-${crypto.randomUUID()}`
  await database.$client.begin(async (sql) => {
    await sql`
      insert into chats (workspace_id, id, type, owner_kind, owner_user_id, name, archived, created_at)
      values (${acme}, ${chatId}, 'runtime', 'user', ${alice}, 'Tools chat', false, now())`
    await sql`
      insert into messages (workspace_id, chat_id, id, seq, kind, author_id, body, created_at)
      values (${acme}, ${chatId}, ${promptId}, 1, 'member', ${prompterId ?? alice}, 'Go', now())`
    await sql`
      insert into runtimes (workspace_id, id, chat_id, host_id, state, host_online, image, llm_token_hash, last_active_at, created_at, state_changed_at)
      values (${acme}, ${crypto.randomUUID()}, ${chatId}, ${host.id}, 'running', true, ${agentServerImage}, ${sha256(token)}, now(), now(), now())`
    if (prompterId)
      await sql`
        update chats set agent_turn_message_id = ${promptId}, agent_turn_prompter_id = ${prompterId} where id = ${chatId}`
  })
  return { chatId, token }
}
const rpcOf = (method: string, params: object = {}) => JSON.stringify({ jsonrpc: '2.0', id: 7, method, params })
const mcpCall = async (host: FakeHost, token: string, body: string, headers: Record<string, string> = {}) => {
  const answer = await host.modelCall({
    path: '/mcp',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...headers,
    },
    body,
  })
  return { status: answer.status, body: answer.body, result: JSON.parse(answer.body || '{}').result }
}
const whoami = rpcOf('tools/call', { name: 'fake-whoami', arguments: {} })
const textOf = (result: { content?: { text: string }[] }) => result?.content?.map((part) => part.text).join('') ?? ''

test('Connect grants the server on the member key, runs the consent through HQ’s callback, and Disconnect deletes the gateway session', async () => {
  const providerKeysBefore = (await virtualKeyOf(alice)).provider_configs.flatMap((config) => config.keys)
  const started = await asMember(alice, 'POST', connectionPath('connect'))
  expect(started.status).toBe(200)
  const { authorizeUrl } = JSON.parse(started.body)
  expect(authorizeUrl).toMatch(/^http:\/\/localhost:\d+\/authorize\?/)
  const key = await virtualKeyOf(alice)
  expect(key.mcp_configs.map((config) => config.mcp_client.name)).toContain('fake')
  expect(key.provider_configs.flatMap((config) => config.keys)).toEqual(providerKeysBefore)

  const consent = await consentThroughHq(authorizeUrl)
  expect(consent).toMatchObject({ callbackPath: '/gateway-oauth/api/oauth/callback', status: 200 })
  expect(consent.page).toContain('"connected":true')
  expect(await asMember(alice, 'POST', connectionPath('refresh'))).toEqual({
    status: 200,
    body: JSON.stringify({ status: 'Connected' }),
  })
  expect(await connectionRows()).toEqual([{ user_id: alice, tool: 'fake', status: 'Connected' }])
  expect((await sessionsOf(key.id)).map((session) => session.status)).toEqual(['active'])
  expect(JSON.parse((await asMember(alice, 'GET', '/api/tool-connections')).body).available).toContain('fake')

  expect((await asMember(alice, 'POST', connectionPath('disconnect'))).status).toBe(204)
  expect(await sessionsOf(key.id)).toEqual([])
  expect(await connectionRows()).toEqual([])
})

test('a refused consent shows the failure page and creates no connection', async () => {
  const started = await asMember(alice, 'POST', connectionPath('connect'))
  expect(started.status).toBe(200)
  const page = await app.request('/gateway-oauth/api/oauth/callback?code=forged&state=forged')
  expect(page.status).toBe(200)
  expect(await page.text()).toContain('"connected":false')
  expect(await asMember(alice, 'POST', connectionPath('refresh'))).toEqual({
    status: 200,
    body: JSON.stringify({ status: null }),
  })
  expect(await connectionRows()).toEqual([])
})

test('a member acts only on their own key: unknown servers and members without a key are refused, and Bob never touches Alice’s connection', async () => {
  expect(await asMember(alice, 'POST', '/api/tool-connections/Jira/connect')).toEqual({
    status: 400,
    body: JSON.stringify({ error: 'tool_not_in_catalog', message: 'Tool Jira is not in the catalog' }),
  })
  expect(await asMember(bob, 'POST', connectionPath('connect'))).toEqual({
    status: 400,
    body: JSON.stringify({ error: 'no_gateway_key', message: 'Add an LLM key before connecting tools' }),
  })
  await connectAlice()
  expect((await asMember(bob, 'POST', connectionPath('disconnect'))).status).toBe(204)
  expect(await asMember(bob, 'POST', connectionPath('refresh'))).toEqual({
    status: 200,
    body: JSON.stringify({ status: null }),
  })
  expect(await connectionRows()).toEqual([{ user_id: alice, tool: 'fake', status: 'Connected' }])
  expect((await sessionsOf((await virtualKeyOf(alice)).id)).map((session) => session.status)).toEqual(['active'])
  expect((await asMember(bob, 'POST', connectionPath('connect'))).status).toBe(400)
})

test('/mcp runs as the chat owner with and without a turn, with HQ’s attribution, and refuses another host’s token', async () => {
  await connectAlice()
  const host = await fakeHost('Tools host')
  const otherHost = await fakeHost('Other tools host')
  const { chatId, token } = await runtimeChat(host, bob)
  const callsBefore = fakeMcp.records.length

  const initialized = await mcpCall(
    host,
    token,
    rpcOf('initialize', { protocolVersion: '2025-06-18', capabilities: {} }),
  )
  expect(initialized.status).toBe(200)
  const listed = await mcpCall(host, token, rpcOf('tools/list'))
  expect(listed.result.tools.map((tool: { name: string }) => tool.name)).toContain('fake-whoami')
  const duringTurn = await mcpCall(host, token, whoami)
  expect(textOf(duringTurn.result)).toBe(`you are ${aliceAccount}`)

  await database.$client`update chats set agent_turn_message_id = null, agent_turn_prompter_id = null where id = ${chatId}`
  expect(textOf((await mcpCall(host, token, whoami)).result)).toBe(`you are ${aliceAccount}`)
  expect(fakeMcp.records.slice(callsBefore).filter((record) => record.tool === 'whoami')).toEqual([
    { tool: 'whoami', user: aliceAccount },
    { tool: 'whoami', user: aliceAccount },
  ])
  expect((await mcpCall(otherHost, token, whoami)).status).toBe(401)

  const ownerKey = await virtualKeyOf(alice)
  const mcpLogs = async () =>
    (
      await gateway.call<{ logs: { virtual_key_id: string; metadata: Record<string, string> | null }[] }>(
        '/api/mcp-logs?limit=100',
      )
    ).logs.filter((log) => log.metadata?.chat === chatId)
  await waitFor(async () => (await mcpLogs()).length >= 2)
  for (const log of await mcpLogs()) {
    expect(log.virtual_key_id).toBe(ownerKey.id)
    expect(log.metadata).toMatchObject({ chat: chatId, owner: alice, workspace: acme })
  }
  expect((await mcpLogs()).map((log) => log.metadata?.prompter)).toContain(bob)
})

test('a server the owner has not connected, or whose token was revoked, answers HQ’s wording and flags the connection', async () => {
  const host = await fakeHost('Unconnected tools host')
  const { token } = await runtimeChat(host, alice)
  await mcpCall(host, token, rpcOf('initialize', { protocolVersion: '2025-06-18', capabilities: {} }))
  const unconnected = await mcpCall(host, token, whoami)
  expect(unconnected).toMatchObject({ status: 200, result: { isError: true } })
  expect(textOf(unconnected.result)).toBe('Alice needs to connect fake')

  await connectAlice()
  await fakeMcp.fetch(new Request(`http://fake-mcp/_admin/expire?user=${aliceAccount}`, { method: 'POST' }))
  const revoked = await mcpCall(host, token, whoami)
  expect(revoked).toMatchObject({ status: 200, result: { isError: true } })
  expect(textOf(revoked.result)).toBe('Alice needs to reconnect fake')
  expect(await connectionRows()).toEqual([{ user_id: alice, tool: 'fake', status: 'Needs reconnection' }])
  for (const answer of [unconnected, revoked]) {
    expect(answer.body).not.toContain('flow=')
    expect(answer.body).not.toContain('vk_')
  }
})

test('session headers pass through, gateway failures become error results instead of 5xx, and model calls carry an empty include-clients header', async () => {
  const seen: { path: string; headers: Record<string, string> }[] = []
  let gatewayAnswer = 200
  const stubGateway = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url)
      seen.push({ path: url.pathname, headers: Object.fromEntries(request.headers) })
      if (gatewayAnswer !== 200) return new Response('down', { status: gatewayAnswer })
      return Response.json({ jsonrpc: '2.0', id: 7, result: {} }, { headers: { 'mcp-session-id': 'gateway-session' } })
    },
  })
  let gatewayUrl = stubGateway.url.origin
  const runtimeHosts = createRuntimeHostGateway({
    databases: () => [database],
    relayModelCall: createModelCallRelay({
      llmGateway,
      gatewayUrlOf: () => gatewayUrl,
      agentBridge: () => agentBridge,
    }),
  })
  const agentBridge = createAgentBridge({ sandboxProvider: runtimeHosts.sandboxProvider, llm: defaultLlm })
  const stubbedApp = createApp({ database, ...testAuthSettings, llmGateway, runtimeHosts, agentBridge })
  const server = Bun.serve({ port: 0, fetch: stubbedApp.fetch, websocket })
  const hosts = createFakeHosts({ port: Number(server.port), database })
  try {
    const host = await hosts.fakeHost('Stubbed gateway host')
    const { token } = await runtimeChat(host, alice)
    const ownerKey = await virtualKeyOf(alice)
    const listed = await mcpCall(host, token, rpcOf('tools/list'), {
      'mcp-session-id': 'agent-session',
      'mcp-protocol-version': '2025-06-18',
      'x-bf-vk': 'sk-bf-not-mine',
      'x-api-key': 'stolen',
    })
    expect(listed.status).toBe(200)
    const forwarded = seen.findLast((request) => request.path === '/mcp')?.headers ?? {}
    expect(forwarded).toMatchObject({
      'mcp-session-id': 'agent-session',
      'mcp-protocol-version': '2025-06-18',
      authorization: `Bearer ${ownerKey.value}`,
      'x-bf-dim-owner': alice,
    })
    expect(Object.keys(forwarded).filter((name) => /x-bf-vk|x-api-key/.test(name))).toEqual([])
    expect(host.receivedFrames.join('\n')).toContain('gateway-session')
    expect(host.receivedFrames.join('\n')).not.toContain(ownerKey.value)

    gatewayAnswer = 503
    const failed = await mcpCall(host, token, whoami)
    expect(failed).toMatchObject({ status: 200, result: { isError: true } })
    expect(textOf(failed.result)).toBe('The tool gateway is unreachable, try again shortly')
    gatewayUrl = 'http://127.0.0.1:9'
    const unreachable = await mcpCall(host, token, whoami)
    expect(unreachable).toMatchObject({ status: 200, result: { isError: true } })
    expect(textOf(unreachable.result)).toBe('The tool gateway is unreachable, try again shortly')

    gatewayAnswer = 200
    gatewayUrl = stubGateway.url.origin
    await host.modelCall({
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'fake/fake-model', messages: [] }),
    })
    const modelCall = seen.findLast((request) => request.path === '/v1/chat/completions')
    expect(modelCall?.headers['x-bf-mcp-include-clients']).toBe('')
  } finally {
    await hosts.disconnectFakeHosts()
    void server.stop(true)
    void stubGateway.stop(true)
  }
})

test('no OAuth token, client secret or virtual key reaches HQ tables, logs or frames to hosts', async () => {
  const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((method) => spyOn(console, method))
  let frames = ''
  try {
    await connectAlice()
    const host = await fakeHost('Secrets host')
    const { token } = await runtimeChat(host, alice)
    expect(textOf((await mcpCall(host, token, whoami)).result)).toBe(`you are ${aliceAccount}`)
    frames = host.receivedFrames.join('\n')
  } finally {
    for (const spy of spies) spy.mockRestore()
  }
  const tables = await database.$client<{ name: string }[]>`
    select table_name as name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE'`
  const stored = JSON.stringify(
    await Promise.all(tables.map(({ name }) => database.$client.unsafe(`select * from "${name}"`))),
  )
  const logged = spies.map((spy) => Bun.inspect(spy.mock.calls)).join('\n')
  const secrets = [...fakeMcp.secrets(), (await virtualKeyOf(alice)).value]
  expect(secrets.length).toBeGreaterThan(2)
  for (const secret of secrets) {
    expect(stored).not.toContain(secret)
    expect(logged).not.toContain(secret)
    expect(frames).not.toContain(secret)
  }
})

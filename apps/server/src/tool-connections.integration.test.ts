import { afterAll, afterEach, beforeEach, expect, setDefaultTimeout, test } from 'bun:test'
import { websocket } from 'hono/bun'
import { createAgentBridge } from './agent-bridge/bridge.ts'
import { createApp } from './app.ts'
import { createModelCallRelay } from './llm-relay.ts'
import { createRuntimeHostGateway } from './runtime-hosts/gateway.ts'
import { fakeAgentLlm } from './testing/fake-llm.ts'
import { sharedToolServer } from './testing/fake-mcp.ts'
import {
  acme,
  addLlmKey,
  alice,
  asMember,
  bob,
  captureConsole,
  connectAlice,
  connectionPath,
  connectionRows,
  consentThroughSpyria,
  createFakeHosts,
  everyStoredText,
  lookup,
  mcpCall,
  openSharedTestApp,
  promptedBy,
  rejectionOf,
  rpcOf,
  runtimeTurn,
  testAuthSettings,
  testSecretsKey,
  textOf,
  virtualKeyOf,
  waitFor,
  whoami,
} from './testing/testing.ts'

setDefaultTimeout(30_000)
const { database, app, port, gateway, llmGateway, fakeMcp } = await openSharedTestApp()
const { fakeHost, disconnectFakeHosts } = createFakeHosts({ port, database })
afterEach(() => disconnectFakeHosts())
afterAll(() => disconnectFakeHosts())

const aliceAccount = `alice-${crypto.randomUUID().slice(0, 8)}`
const aliceCookie = `fake_mcp_user=${aliceAccount}`
beforeEach(() => asMember(alice, 'POST', connectionPath('disconnect')))
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

test('Connect grants the server on the member key, runs the consent through Spyria’s callback, and Disconnect deletes the gateway session', async () => {
  const providerKeysBefore = (await virtualKeyOf(alice)).provider_configs.flatMap((config) => config.keys)
  const started = await asMember(alice, 'POST', connectionPath('connect'))
  expect(started.status).toBe(200)
  const { authorizeUrl } = JSON.parse(started.body)
  expect(authorizeUrl).toMatch(/^http:\/\/localhost:\d+\/authorize\?/)
  const key = await virtualKeyOf(alice)
  expect(key.mcp_configs.map((config) => config.mcp_client.name)).toContain('fake')
  expect(key.provider_configs.flatMap((config) => config.keys)).toEqual(providerKeysBefore)

  const consent = await consentThroughSpyria(authorizeUrl, aliceCookie)
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

test('a pending sign-in left behind does not block Connect, and Connect while signed in drops the token so no tool reaches the server', async () => {
  const callsBefore = fakeMcp.records.length
  expect((await asMember(alice, 'POST', connectionPath('connect'))).status).toBe(200)
  expect((await asMember(alice, 'POST', connectionPath('connect'))).status).toBe(200)
  await connectAlice(aliceCookie)
  const key = await virtualKeyOf(alice)
  expect((await sessionsOf(key.id)).map((session) => session.status)).toEqual(['active'])

  expect((await asMember(alice, 'POST', connectionPath('connect'))).status).toBe(200)
  expect((await sessionsOf(key.id)).map((session) => session.status)).toEqual(['pending'])
  expect(fakeMcp.records.slice(callsBefore)).toEqual([])
})

test('a member acts only on their own key: unknown servers are refused, a member without an LLM key connects on a key that serves only tools, and Bob never touches Alice’s connection', async () => {
  expect(await asMember(alice, 'POST', '/api/tool-connections/Jira/connect')).toEqual({
    status: 400,
    body: JSON.stringify({ error: 'tool_not_in_catalog', message: 'Tool Jira is not in the catalog' }),
  })
  expect((await asMember(bob, 'POST', connectionPath('connect'))).status).toBe(200)
  const bobKey = await virtualKeyOf(bob)
  expect(bobKey.provider_configs ?? []).toEqual([])
  await connectAlice(aliceCookie)
  expect((await virtualKeyOf(alice)).id).not.toBe(bobKey.id)
  expect((await asMember(bob, 'POST', connectionPath('disconnect'))).status).toBe(204)
  expect(await asMember(bob, 'POST', connectionPath('refresh'))).toEqual({
    status: 200,
    body: JSON.stringify({ status: null }),
  })
  expect(await connectionRows()).toEqual([{ user_id: alice, tool: 'fake', status: 'Connected' }])
  expect((await sessionsOf((await virtualKeyOf(alice)).id)).map((session) => session.status)).toEqual(['active'])
})

test('/mcp runs as the chat owner with Spyria’s attribution, lists Spyria’s own tools first then the gateway’s outside a turn but calls them only during one, and refuses another host’s token', async () => {
  await connectAlice(aliceCookie)
  const host = await fakeHost('Tools host')
  const otherHost = await fakeHost('Other tools host')
  const { chatId, token } = await runtimeTurn(host, alice)
  const callsBefore = fakeMcp.records.length

  const initialized = await mcpCall(
    host,
    token,
    rpcOf('initialize', { protocolVersion: '2025-06-18', capabilities: {} }),
  )
  expect(initialized.status).toBe(200)
  const listed = await mcpCall(host, token, rpcOf('tools/list'))
  const listedNames = listed.result.tools.map((tool: { name: string }) => tool.name)
  expect(listedNames[0]).toBe('open_page')
  expect(listedNames).toContain('fake-whoami')
  const duringTurn = await mcpCall(host, token, whoami)
  expect(textOf(duringTurn.result)).toBe(`you are ${aliceAccount}`)

  await database.$client`update chats set agent_turn_message_id = null, agent_turn_prompter_id = null where id = ${chatId}`
  expect((await mcpCall(host, token, rpcOf('tools/list'))).result.tools.length).toBeGreaterThan(0)
  const outsideTurn = await mcpCall(host, token, whoami)
  expect(outsideTurn).toMatchObject({ status: 200, result: { isError: true } })
  expect(textOf(outsideTurn.result)).toBe('This runtime has no active turn')
  expect(fakeMcp.records.slice(callsBefore).filter((record) => record.tool === 'whoami')).toEqual([
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
  await waitFor(async () => (await mcpLogs()).length >= 1)
  for (const log of await mcpLogs()) {
    expect(log.virtual_key_id).toBe(ownerKey.id)
    expect(log.metadata).toMatchObject({ chat: chatId, owner: alice, prompter: alice, workspace: acme })
  }
})

test('/mcp for a chat owner without an LLM key runs the workspace tools on a key that serves only tools, and a personal tool call answers that the owner needs to connect', async () => {
  const host = await fakeHost('Keyless tools host')
  const { token } = await runtimeTurn(host, bob, bob)
  const initialized = await mcpCall(
    host,
    token,
    rpcOf('initialize', { protocolVersion: '2025-06-18', capabilities: {} }),
  )
  expect(initialized.status).toBe(200)
  expect((await virtualKeyOf(bob)).provider_configs ?? []).toEqual([])
  const listed = await mcpCall(host, token, rpcOf('tools/list'))
  expect(listed.result.tools.map((tool: { name: string }) => tool.name)).toContain(`${sharedToolServer}-lookup`)
  expect(textOf((await mcpCall(host, token, lookup)).result)).toBe('ran lookup')
  const called = await mcpCall(host, token, whoami)
  expect(called).toMatchObject({ status: 200, result: { isError: true } })
  expect(textOf(called.result)).toBe('Bob needs to connect fake')
})

test('the profile lists only personal servers, and a workspace server cannot be connected', async () => {
  expect(JSON.parse((await asMember(alice, 'GET', '/api/tool-connections')).body).available).toEqual(['fake'])
  expect(await asMember(alice, 'POST', `/api/tool-connections/${sharedToolServer}/connect`)).toMatchObject({
    status: 400,
  })
})

test('a server the owner has not connected, or whose token was revoked, answers Spyria’s wording and flags the connection', async () => {
  const host = await fakeHost('Unconnected tools host')
  const { token } = await runtimeTurn(host, alice)
  await mcpCall(host, token, rpcOf('initialize', { protocolVersion: '2025-06-18', capabilities: {} }))
  const unconnected = await mcpCall(host, token, whoami)
  expect(unconnected).toMatchObject({ status: 200, result: { isError: true } })
  expect(textOf(unconnected.result)).toBe('Alice needs to connect fake')

  await connectAlice(aliceCookie)
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

test('session headers pass through, gateway failures become error results instead of 5xx, model calls carry an empty include-clients header and guest calls their server only', async () => {
  const seen: { path: string; headers: Record<string, string> }[] = []
  const readOnlyLookup = { name: `${sharedToolServer}-lookup`, annotations: { readOnlyHint: true } }
  let gatewayAnswer = 200
  const stubGateway = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url)
      seen.push({ path: url.pathname, headers: Object.fromEntries(request.headers) })
      if (gatewayAnswer !== 200) return new Response('down', { status: gatewayAnswer })
      return Response.json(
        { jsonrpc: '2.0', id: 7, result: { tools: [readOnlyLookup] } },
        { headers: { 'mcp-session-id': 'gateway-session' } },
      )
    },
  })
  let gatewayUrl = stubGateway.url.origin
  const runtimeHosts = createRuntimeHostGateway({
    runtimeKeySecret: testSecretsKey,
    databases: () => [database],
    relayModelCall: createModelCallRelay({
      llmGateway,
      gatewayUrlOf: () => gatewayUrl,
      agentBridge: () => agentBridge,
    }),
  })
  const agentBridge = createAgentBridge({ sandboxProvider: runtimeHosts.sandboxProvider, llm: fakeAgentLlm })
  const stubbedApp = createApp({ database, ...testAuthSettings, llmGateway, runtimeHosts, agentBridge })
  const server = Bun.serve({ port: 0, fetch: stubbedApp.fetch, websocket })
  const hosts = createFakeHosts({ port: Number(server.port), database })
  try {
    const host = await hosts.fakeHost('Stubbed gateway host')
    const { chatId, token } = await runtimeTurn(host, alice)
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
      body: JSON.stringify({ model: 'mistral/codestral-latest', messages: [] }),
    })
    const modelCall = seen.findLast((request) => request.path === '/v1/chat/completions')
    expect(modelCall?.headers['x-bf-mcp-include-clients']).toBe('')

    await addLlmKey(bob, 'Mistral')
    await promptedBy(chatId, bob)
    await mcpCall(host, token, lookup)
    expect(seen.findLast((request) => request.path === '/mcp')?.headers['x-bf-mcp-include-clients']).toBe(
      sharedToolServer,
    )
  } finally {
    await hosts.disconnectFakeHosts()
    void server.stop(true)
    void stubGateway.stop(true)
  }
})

test('no OAuth token, client secret or virtual key reaches Spyria tables, logs or frames to hosts', async () => {
  const consoleCalls = captureConsole()
  let frames = ''
  try {
    await connectAlice(aliceCookie)
    const host = await fakeHost('Secrets host')
    const { token } = await runtimeTurn(host, alice)
    expect(textOf((await mcpCall(host, token, whoami)).result)).toBe(`you are ${aliceAccount}`)
    frames = host.receivedFrames.join('\n')
  } finally {
    consoleCalls.restore()
  }
  const stored = await everyStoredText(database)
  const logged = consoleCalls.logged()
  const secrets = [...fakeMcp.secrets(), (await virtualKeyOf(alice)).value]
  expect(secrets.length).toBeGreaterThan(2)
  for (const secret of secrets) {
    expect(stored).not.toContain(secret)
    expect(logged).not.toContain(secret)
    expect(frames).not.toContain(secret)
  }
})

test('a tool server name with "-" is refused at registration, so a tool name always splits into its server and tool', async () => {
  const hyphenated = { name: `${sharedToolServer}-pro`, url: 'http://host.docker.internal:1/mcp', isShared: true }
  expect((await rejectionOf(llmGateway.setUpToolServer(hyphenated))).message).toContain(
    'A tool server name cannot contain "-"',
  )
  expect((await llmGateway.toolServers()).map(({ name }) => name)).not.toContain(hyphenated.name)
})

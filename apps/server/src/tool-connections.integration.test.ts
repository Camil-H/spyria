import { afterAll, afterEach, beforeEach, expect, setDefaultTimeout, test } from 'bun:test'
import { chatId as toChatId } from '@hq/kernel'
import { websocket } from 'hono/bun'
import { createAgentBridge } from './agent-bridge/bridge.ts'
import { createApp, defaultLlm } from './app.ts'
import { createModelCallRelay } from './llm-relay.ts'
import { createRuntimeHostGateway } from './runtime-hosts/gateway.ts'
import { sharedToolServer } from './testing/fake-mcp.ts'
import {
  acme,
  addLlmKey,
  alice,
  aliceInAcme,
  captureConsole,
  createFakeHosts,
  everyStoredText,
  type FakeHost,
  openSharedTestApp,
  runtimeTurn,
  bob,
  sessionTokenOf,
  startAgentStack,
  testAuthSettings,
  virtualKeyOf,
  waitFor,
} from './testing/testing.ts'

setDefaultTimeout(30_000)
const approvalWindowMilliseconds = 2_000
const approvals = await startAgentStack({ routing: true, approvalWindowMilliseconds })
const { database, app, port, gateway, llmGateway, fakeMcp } = await openSharedTestApp()
const { fakeHost, disconnectFakeHosts } = createFakeHosts({ port, database })
afterEach(() => disconnectFakeHosts())
afterAll(() => disconnectFakeHosts())

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

test('/mcp runs as the chat owner with HQ’s attribution, lists tools outside a turn but calls them only during one, and refuses another host’s token', async () => {
  await connectAlice()
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
  expect(listed.result.tools.map((tool: { name: string }) => tool.name)).toContain('fake-whoami')
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

const lookup = rpcOf('tools/call', { name: `${sharedToolServer}-lookup`, arguments: {} })
const update = rpcOf('tools/call', { name: `${sharedToolServer}-update`, arguments: { text: 'new' } })
const promptedBy = (chatId: string, prompterId: string) =>
  database.$client`update chats set agent_turn_prompter_id = ${prompterId} where id = ${chatId}`
const toolCallRows = async (chatId: string, count: number) => {
  const rows = async () => [
    ...(await database.$client`
      select prompter_id, owner_id, server, tool, read_only, decision, decided_by, status
      from tool_calls where chat_id = ${chatId} order by called_at`),
  ]
  await waitFor(async () => (await rows()).length >= count)
  return rows()
}
const allowSharedTools = async (userId: string, tools: string[]) => {
  const key = (await virtualKeyOf(userId)) as unknown as {
    id: string
    mcp_configs: { id: number; mcp_client: { name: string }; tools_to_execute: string[] }[]
  }
  await gateway.call(`/api/governance/virtual-keys/${key.id}`, {
    method: 'PUT',
    body: {
      mcp_configs: key.mcp_configs.map((config) => ({
        id: config.id,
        mcp_client_name: config.mcp_client.name,
        tools_to_execute: config.mcp_client.name === sharedToolServer ? tools : config.tools_to_execute,
      })),
    },
  })
}
const refused = (answer: { status: number | undefined; result: { content?: { text: string }[] } }) => ({
  status: answer.status,
  text: textOf(answer.result),
})

test('on a guest’s prompt the owner’s personal connection is refused before the gateway, and the owner’s own prompt uses it; every call is audited', async () => {
  await connectAlice()
  const host = await fakeHost('Guest personal host')
  const { chatId, token } = await runtimeTurn(host, bob)
  const callsBefore = fakeMcp.records.length

  const guestCall = await mcpCall(host, token, whoami)
  expect(guestCall).toMatchObject({ status: 200, result: { isError: true } })
  expect(textOf(guestCall.result)).toBe("fake is Alice's personal connection, used only on Alice's own prompts")
  expect(fakeMcp.records.slice(callsBefore)).toEqual([])
  expect(await connectionRows()).toEqual([{ user_id: alice, tool: 'fake', status: 'Connected' }])

  await promptedBy(chatId, alice)
  expect(textOf((await mcpCall(host, token, whoami)).result)).toBe(`you are ${aliceAccount}`)
  const audited = { owner_id: alice, server: 'fake', tool: 'whoami', decision: 'not_needed', decided_by: null }
  expect(await toolCallRows(chatId, 2)).toEqual([
    { ...audited, prompter_id: bob, read_only: null, status: 'refused' },
    { ...audited, prompter_id: alice, read_only: true, status: 'succeeded' },
  ])
})

test('on a guest’s prompt a workspace tool needs both the owner’s and the prompter’s grants, and the gateway only sees that server', async () => {
  await addLlmKey(bob, 'Fake')
  const host = await fakeHost('Guest workspace host')
  const { chatId, token } = await runtimeTurn(host, bob)
  const callsBefore = fakeMcp.records.length
  try {
    expect(textOf((await mcpCall(host, token, lookup)).result)).toBe('ran lookup')

    await allowSharedTools(bob, ['update'])
    expect(refused(await mcpCall(host, token, lookup))).toEqual({
      status: 200,
      text: `${sharedToolServer} isn't available on Bob's prompts in this chat`,
    })
    await allowSharedTools(bob, ['*'])
    await allowSharedTools(alice, ['update'])
    expect(refused(await mcpCall(host, token, lookup))).toEqual({
      status: 200,
      text: `${sharedToolServer} isn't available on Bob's prompts in this chat`,
    })
  } finally {
    await allowSharedTools(alice, ['*'])
    await allowSharedTools(bob, ['*'])
  }
  expect(fakeMcp.records.slice(callsBefore)).toEqual([{ tool: 'lookup', user: 'shared' }])
  const audited = {
    prompter_id: bob,
    owner_id: alice,
    server: sharedToolServer,
    decision: 'not_needed',
    decided_by: null,
  }
  expect(await toolCallRows(chatId, 3)).toEqual([
    { ...audited, tool: 'lookup', read_only: true, status: 'succeeded' },
    { ...audited, tool: 'lookup', read_only: null, status: 'refused' },
    { ...audited, tool: 'lookup', read_only: null, status: 'refused' },
  ])
})

test('the profile lists only personal servers, and a workspace server cannot be connected', async () => {
  expect(JSON.parse((await asMember(alice, 'GET', '/api/tool-connections')).body).available).toEqual(['fake'])
  expect(await asMember(alice, 'POST', `/api/tool-connections/${sharedToolServer}/connect`)).toMatchObject({
    status: 400,
  })
})

test('a server the owner has not connected, or whose token was revoked, answers HQ’s wording and flags the connection', async () => {
  const host = await fakeHost('Unconnected tools host')
  const { token } = await runtimeTurn(host, alice)
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

test('session headers pass through, gateway failures become error results instead of 5xx, model calls carry an empty include-clients header and guest calls their server only', async () => {
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
      body: JSON.stringify({ model: 'fake/fake-model', messages: [] }),
    })
    const modelCall = seen.findLast((request) => request.path === '/v1/chat/completions')
    expect(modelCall?.headers['x-bf-mcp-include-clients']).toBe('')

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

test('no OAuth token, client secret or virtual key reaches HQ tables, logs or frames to hosts', async () => {
  const consoleCalls = captureConsole()
  let frames = ''
  try {
    await connectAlice()
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

test('a guest’s turn answers only tool and session methods, so resources, prompts and batches never reach the gateway on the owner’s key', async () => {
  const host = await fakeHost('Guest methods host')
  const { chatId, token } = await runtimeTurn(host, bob)
  const notFound = { jsonrpc: '2.0', id: 7, error: { code: -32601, message: 'Method not found' } }
  for (const method of ['resources/list', 'prompts/list', 'completion/complete'])
    expect(JSON.parse((await mcpCall(host, token, rpcOf(method))).body)).toEqual(notFound)
  expect(JSON.parse((await mcpCall(host, token, `[${whoami}]`)).body)).toEqual({ ...notFound, id: null })
  expect(
    (await mcpCall(host, token, JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }))).status,
  ).toBe(202)
  expect((await mcpCall(host, token, rpcOf('ping'))).result).toEqual({})

  await promptedBy(chatId, alice)
  expect(JSON.parse((await mcpCall(host, token, rpcOf('resources/list'))).body).error.message).toBe(
    'resources not supported',
  )
})

const approvalOf = async (frames: string[], count: number) => {
  const shown = () =>
    frames.map((frame) => JSON.parse(frame).question).filter((question) => question?.kind === 'approval')
  await waitFor(() => shown().length >= count)
  return shown()[count - 1]
}
const answerAs = async (userId: string, chatId: string, questionId: string, approve: boolean) =>
  (
    await approvals.app.request(`/api/chats/${chatId}/questions/${questionId}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${await sessionTokenOf(database, acme, userId)}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ approve }),
    })
  ).status
const guestTurnWithApprovals = async (name: string) => {
  const host = await approvals.fakeHost(name)
  const { chatId, token } = await runtimeTurn(host, bob)
  return { host, chatId, token, frames: (await approvals.openStream(toChatId(chatId))).frames }
}
const approvalStepsOf = async (chatId: string, count: number) => {
  const steps = async () =>
    (
      await database.$client`
        select step from messages where chat_id = ${chatId} and step->>'kind' = 'approval' order by seq`
    ).map(({ step }) => ({ approved: step.approved, answeredBy: step.answeredBy, closed: step.closed }))
  await waitFor(async () => (await steps()).length >= count)
  return steps()
}
const notApproved = { status: 200, text: 'Alice did not approve this call' }

test('a guest’s write call waits for the owner: approved it runs, denied it gets the refusal; only the owner answers and read-only calls never wait', async () => {
  const { host, chatId, token, frames } = await guestTurnWithApprovals('Approvals host')
  const callsBefore = fakeMcp.records.length
  expect(textOf((await mcpCall(host, token, lookup)).result)).toBe('ran lookup')

  const approvedCall = mcpCall(host, token, update)
  const first = await approvalOf(frames, 1)
  expect(first).toMatchObject({
    sessionUpdate: 'question',
    approval: {
      server: sharedToolServer,
      tool: 'update',
      arguments: '{"text":"new"}',
      prompterName: 'Bob',
      ownerName: 'Alice',
    },
  })
  expect(await answerAs(bob, chatId, first.questionId, true)).toBe(403)
  expect(await answerAs(alice, chatId, first.questionId, true)).toBe(200)
  expect(textOf((await approvedCall).result)).toBe('ran update')
  expect(await answerAs(alice, chatId, first.questionId, true)).toBe(409)

  const deniedCall = mcpCall(host, token, update)
  expect(await answerAs(alice, chatId, (await approvalOf(frames, 2)).questionId, false)).toBe(200)
  expect(refused(await deniedCall)).toEqual(notApproved)

  expect(fakeMcp.records.slice(callsBefore)).toEqual([
    { tool: 'lookup', user: 'shared' },
    { tool: 'update', user: 'shared' },
  ])
  expect(await approvalStepsOf(chatId, 2)).toEqual([
    { approved: true, answeredBy: alice, closed: undefined },
    { approved: false, answeredBy: alice, closed: undefined },
  ])
  const audited = { prompter_id: bob, owner_id: alice, server: sharedToolServer }
  expect(await toolCallRows(chatId, 3)).toEqual([
    { ...audited, tool: 'lookup', read_only: true, decision: 'not_needed', decided_by: null, status: 'succeeded' },
    { ...audited, tool: 'update', read_only: false, decision: 'approved', decided_by: alice, status: 'succeeded' },
    { ...audited, tool: 'update', read_only: false, decision: 'denied', decided_by: alice, status: 'refused' },
  ])
})

test('an approval nobody answers expires, Stop cancels a pending one, and the owner’s own write call never asks', async () => {
  const { host, chatId, token, frames } = await guestTurnWithApprovals('Expiring approvals host')
  const startedAt = Date.now()
  const expiringCall = mcpCall(host, token, update)
  await approvalOf(frames, 1)
  expect(refused(await expiringCall)).toEqual(notApproved)
  expect(Date.now() - startedAt).toBeGreaterThanOrEqual(approvalWindowMilliseconds)

  const stoppedCall = mcpCall(host, token, update)
  await approvalOf(frames, 2)
  await approvals.mutate(aliceInAcme, 'conversation.stopAgent', { workspaceId: acme, chatId })
  expect(refused(await stoppedCall)).toEqual(notApproved)

  const ownerTurn = await runtimeTurn(host, alice)
  expect(textOf((await mcpCall(host, ownerTurn.token, update)).result)).toBe('ran update')
  expect(await approvalStepsOf(chatId, 2)).toEqual([
    { approved: undefined, answeredBy: undefined, closed: 'expired' },
    { approved: undefined, answeredBy: undefined, closed: 'stopped' },
  ])
  const audited = { owner_id: alice, server: sharedToolServer, tool: 'update', read_only: false, decided_by: null }
  expect(await toolCallRows(chatId, 2)).toEqual([
    { ...audited, prompter_id: bob, decision: 'expired', status: 'refused' },
    { ...audited, prompter_id: bob, decision: 'cancelled', status: 'refused' },
  ])
  expect(await toolCallRows(ownerTurn.chatId, 1)).toEqual([
    { ...audited, prompter_id: alice, decision: 'not_needed', status: 'succeeded' },
  ])
  expect(frames.filter((frame) => JSON.parse(frame).question).length).toBe(2)
})

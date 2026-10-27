import { afterAll, afterEach, expect, setDefaultTimeout, test } from 'bun:test'
import { zeroDrizzle } from '@rocicorp/zero/server/adapters/drizzle'
import { schema } from '@spyria/db/zero'
import { createZeroStore } from '@spyria/db/zero-store'
import { createToolCallOwnerAccess } from '@spyria/profile/server'
import { startJobWorker } from './job-worker.ts'
import { sharedSecretHeader, sharedToolServer } from './testing/fake-mcp.ts'
import {
  acme,
  addLlmKey,
  alice,
  asMember,
  bob,
  createFakeHosts,
  everyStoredText,
  globex,
  lee,
  mcpCall,
  openSharedTestApp,
  openZeroStore,
  rpcOf,
  runtimeTurn,
  sharedMcpUrl,
  succeeded,
  textOf,
  virtualKeyOf,
  waitFor,
  workspaceEventsOf,
} from './testing/testing.ts'

setDefaultTimeout(30_000)
const { database, port, gateway, llmGateway, fakeMcp, resultOf } = await openSharedTestApp()
const { fakeHost, disconnectFakeHosts } = createFakeHosts({ port, database })
const worker = startJobWorker(database, { pollIntervalMilliseconds: 5, retryDelayMilliseconds: 100, llmGateway })
afterEach(() => disconnectFakeHosts())
afterAll(async () => {
  await disconnectFakeHosts()
  await worker.stop()
})

const connectionsPath = '/api/workspace-connections'
const crmPath = (action: string) => `${connectionsPath}/connection-crm/${action}`
const callOf = (server: string, tool: string) => rpcOf('tools/call', { name: `${server}-${tool}`, arguments: {} })
const register = async (name: string, secret?: string, url = sharedMcpUrl) => {
  const answer = await asMember(alice, 'POST', connectionsPath, {
    name,
    url,
    ...(secret && { secretHeader: { name: sharedSecretHeader, value: secret } }),
  })
  expect(answer.status).toBe(201)
  return JSON.parse(answer.body) as { connectionId: string }
}
const connectionRow = async (connectionId: string) =>
  (
    await database.$client<{ name: string; gatewayName: string; headerName: string | null; allowedTools: string[] }[]>`
      select name, gateway_name as "gatewayName", header_name as "headerName", tools, allowed_tools as "allowedTools"
      from workspace_connections where id = ${connectionId}`
  )[0]
const gatewayClientNames = async () => (await llmGateway.toolServers()).map(({ name }) => name)
const grantsOf = async (userId: string) =>
  Object.fromEntries(
    (await virtualKeyOf(userId)).mcp_configs.map((config) => [config.mcp_client.name, config.tools_to_execute]),
  )
const restrict = (memberId: string, allowedTools: string[] | null) =>
  asMember(alice, 'POST', crmPath('restrict'), { memberId, allowedTools })
const removeKeysOf = async (userId: string) => {
  for (const { id } of await database.$client<{ id: string }[]>`
    select id from llm_credentials where workspace_id = ${acme} and user_id = ${userId}`)
    expect(
      await resultOf({ workspaceId: acme, userId }, 'profile.removeLlmCredential', {
        workspaceId: acme,
        credentialId: id,
      }),
    ).toEqual(succeeded)
  await waitFor(async () => !(await virtualKeyOf(userId)).provider_configs?.length)
}

test('an admin registers a shared server with a secret header: Spyria lists its tools, the secret reaches the server only through the gateway, never a Spyria table or read, and the event is recorded', async () => {
  const secret = `crm-secret-${crypto.randomUUID()}`
  expect((await asMember(bob, 'POST', connectionsPath, { name: 'Billing', url: sharedMcpUrl })).status).toBe(403)
  const { connectionId } = await register('Billing', secret)
  const row = await connectionRow(connectionId)
  expect(row).toEqual({
    name: 'Billing',
    gatewayName: expect.stringMatching(/^billing_[0-9a-f]{6}$/),
    headerName: sharedSecretHeader,
    tools: [
      { name: 'lookup', readOnly: true },
      { name: 'update', readOnly: false },
    ],
    allowedTools: ['lookup', 'update'],
  } as never)
  expect(await gatewayClientNames()).toContain(row?.gatewayName ?? '')
  expect((await grantsOf(alice))[row?.gatewayName ?? '']).toEqual(['lookup', 'update'])

  const host = await fakeHost('Shared server host')
  const { token } = await runtimeTurn(host, alice)
  const callsBefore = fakeMcp.records.length
  expect(textOf((await mcpCall(host, token, callOf(row?.gatewayName ?? '', 'lookup'))).result)).toBe('ran lookup')
  expect(fakeMcp.records.slice(callsBefore)).toEqual([{ tool: 'lookup', user: secret }])

  const bobStore = await openZeroStore(createZeroStore, bob, [acme])
  await waitFor(() => bobStore.read().workspaceConnections.some((connection) => connection.id === connectionId))
  expect(JSON.stringify(bobStore.read())).not.toContain(secret)
  expect(await everyStoredText(database)).not.toContain(secret)
  expect((await workspaceEventsOf(database)).at(-1)).toEqual({
    type: 'connection.added',
    actorId: alice,
    payload: { connectionId, name: 'Billing', url: sharedMcpUrl, hasSecret: true },
  })
})

test('a server that lists no tools is refused and left out of the gateway', async () => {
  const before = await gatewayClientNames()
  const answer = await asMember(alice, 'POST', connectionsPath, {
    name: 'Dead',
    url: 'http://host.docker.internal:9/mcp',
  })
  expect(answer).toMatchObject({ status: 400 })
  expect(JSON.parse(answer.body)).toEqual({
    error: 'connection_unreachable',
    message: 'No tools could be listed from http://host.docker.internal:9/mcp',
  })
  expect((await gatewayClientNames()).filter((name) => name.startsWith('dead_'))).toEqual(
    before.filter((name) => name.startsWith('dead_')),
  )
})

test('a member restricted to lookup is refused update on their own prompts, their key holds exactly lookup, and the key kept after the last LLM key is removed keeps the restriction', async () => {
  expect((await restrict(bob, ['lookup'])).status).toBe(200)
  await addLlmKey(bob, 'Mistral')
  expect((await grantsOf(bob))[sharedToolServer]).toEqual(['lookup'])

  const host = await fakeHost('Restricted member host')
  const { token } = await runtimeTurn(host, bob, bob)
  expect(textOf((await mcpCall(host, token, callOf(sharedToolServer, 'lookup'))).result)).toBe('ran lookup')
  expect(textOf((await mcpCall(host, token, callOf(sharedToolServer, 'update'))).result)).toBe(
    `${sharedToolServer} isn't available on Bob's prompts in this chat`,
  )

  const keyBefore = (await virtualKeyOf(bob)).id
  await removeKeysOf(bob)
  expect((await virtualKeyOf(bob)).id).toBe(keyBefore)
  expect((await grantsOf(bob))[sharedToolServer]).toEqual(['lookup'])
  expect(textOf((await mcpCall(host, token, callOf(sharedToolServer, 'lookup'))).result)).toBe('ran lookup')
  await addLlmKey(bob, 'Mistral')
  expect((await virtualKeyOf(bob)).id).toBe(keyBefore)
  expect(textOf((await mcpCall(host, token, callOf(sharedToolServer, 'update'))).result)).toBe(
    `${sharedToolServer} isn't available on Bob's prompts in this chat`,
  )

  expect((await restrict(bob, [])).status).toBe(200)
  expect((await grantsOf(bob))[sharedToolServer]).toBeUndefined()
  expect((await restrict(bob, null)).status).toBe(200)
  expect((await grantsOf(bob))[sharedToolServer]).toEqual(['lookup', 'update'])
  expect((await restrict(bob, ['delete'])).status).toBe(400)
  expect((await asMember(bob, 'POST', crmPath('restrict'), { memberId: bob, allowedTools: null })).status).toBe(403)
  expect(
    (await workspaceEventsOf(database))
      .filter(({ type }) => type === 'connection.restricted')
      .map(({ payload }) => payload),
  ).toEqual([
    { connectionId: 'connection-crm', memberId: bob, allowedTools: ['lookup'] },
    { connectionId: 'connection-crm', memberId: bob, allowedTools: [] },
    { connectionId: 'connection-crm', memberId: bob, allowedTools: null },
  ])
})

test('a restriction syncs to its member and to admins, not to a member who reads none of their chats', async () => {
  await restrict(lee, ['lookup'])
  const restrictionsOf = async (userId: string, isLeeSynced: boolean) => {
    const store = await openZeroStore(createZeroStore, userId as never, [acme])
    const restrictions = () =>
      store.read().connectionRestrictions.map(({ memberId, allowedTools }) => ({ memberId, allowedTools }))
    await waitFor(
      () =>
        store.read().workspaceConnections.length > 0 &&
        (!isLeeSynced || restrictions().some(({ memberId }) => memberId === lee)),
    )
    return restrictions()
  }
  const leeRestriction = { memberId: lee, allowedTools: ['lookup'] }
  expect(await restrictionsOf(lee, true)).toContainEqual(leeRestriction)
  expect(await restrictionsOf(alice, true)).toContainEqual(leeRestriction)
  expect(await restrictionsOf(bob, false)).not.toContainEqual(leeRestriction)
})

test('unticking a tool for the workspace removes it from every key and every prompt', async () => {
  expect((await asMember(alice, 'POST', crmPath('tools'), { allowedTools: ['lookup'] })).status).toBe(200)
  expect((await grantsOf(alice))[sharedToolServer]).toEqual(['lookup'])
  const host = await fakeHost('Workspace untick host')
  const { token } = await runtimeTurn(host, alice)
  expect(textOf((await mcpCall(host, token, callOf(sharedToolServer, 'update'))).result)).toBe(
    `${sharedToolServer} isn't available on Alice's prompts in this chat`,
  )
  expect(textOf((await mcpCall(host, token, callOf(sharedToolServer, 'lookup'))).result)).toBe('ran lookup')
  expect((await asMember(bob, 'POST', crmPath('tools'), { allowedTools: ['lookup', 'update'] })).status).toBe(403)
  expect((await workspaceEventsOf(database)).at(-1)).toEqual({
    type: 'connection.updated',
    actorId: alice,
    payload: { connectionId: 'connection-crm', allowedTools: ['lookup'] },
  })
})

test('a workspace’s connections are never granted to, listed for or callable by another workspace’s member', async () => {
  const { connectionId } = await register('Ledger')
  const gatewayName = (await connectionRow(connectionId))?.gatewayName ?? ''
  const globexKey = await asMember(
    alice,
    'POST',
    '/api/llm-credentials',
    { provider: 'Mistral', secret: 'fake-globex' },
    globex,
  )
  expect(globexKey.status).toBe(201)
  const [row] = await database.$client`
    select virtual_key_id from member_gateway_keys where workspace_id = ${globex} and user_id = ${alice}`
  const key = (
    await gateway.call<{ virtual_key: { value: string; mcp_configs: { mcp_client: { name: string } }[] } }>(
      `/api/governance/virtual-keys/${row?.virtual_key_id}`,
    )
  ).virtual_key
  expect(key.mcp_configs.map((config) => config.mcp_client.name)).not.toContain(gatewayName)
  expect(key.mcp_configs.map((config) => config.mcp_client.name)).not.toContain(sharedToolServer)
  const listed = await fetch(`${llmGateway.url}/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${key.value}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: rpcOf('tools/list'),
  })
  expect(await listed.text()).not.toContain(gatewayName)
  const access = createToolCallOwnerAccess((work) => zeroDrizzle(schema, database).transaction(work), llmGateway)
  expect(await access.toolCallAccess(globex, alice, alice, `${gatewayName}-lookup`)).toBe('not_allowed')
  expect(await access.toolCallAccess(acme, alice, alice, `${gatewayName}-lookup`)).toBe('allowed')
})

test('editing replaces the secret in place, a new URL registers the server again and regrants it, and removing deletes it from the gateway and Spyria', async () => {
  const { connectionId } = await register('Orders', 'first-secret')
  const path = (action: string) => `${connectionsPath}/${connectionId}/${action}`
  const firstName = (await connectionRow(connectionId))?.gatewayName ?? ''
  const host = await fakeHost('Edited server host')
  const { token } = await runtimeTurn(host, alice)
  const lookupUser = async (server: string) => {
    const callsBefore = fakeMcp.records.length
    await mcpCall(host, token, callOf(server, 'lookup'))
    return fakeMcp.records.slice(callsBefore).map(({ user }) => user)
  }

  const header = (value: string) => ({ name: sharedSecretHeader, value })
  expect(
    (
      await asMember(alice, 'POST', path('edit'), {
        name: 'Orders',
        url: sharedMcpUrl,
        secretHeader: header('second-secret'),
      })
    ).status,
  ).toBe(200)
  expect((await connectionRow(connectionId))?.gatewayName).toBe(firstName)
  expect(await lookupUser(firstName)).toEqual(['second-secret'])

  const movedUrl = `${sharedMcpUrl}?moved`
  const withoutSecret = await asMember(alice, 'POST', path('edit'), { name: 'Orders', url: movedUrl })
  expect(JSON.parse(withoutSecret.body)).toEqual({
    error: 'secret_required',
    message: `Enter the ${sharedSecretHeader} header again to change the URL`,
  })
  expect(
    (
      await asMember(alice, 'POST', path('edit'), {
        name: 'Orders',
        url: movedUrl,
        secretHeader: header('third-secret'),
      })
    ).status,
  ).toBe(200)
  const secondName = (await connectionRow(connectionId))?.gatewayName ?? ''
  expect(secondName).not.toBe(firstName)
  expect(await gatewayClientNames()).not.toContain(firstName)
  expect((await grantsOf(alice))[secondName]).toEqual(['lookup', 'update'])
  expect(await lookupUser(secondName)).toEqual(['third-secret'])

  expect((await asMember(alice, 'POST', path('restrict'), { memberId: bob, allowedTools: ['lookup'] })).status).toBe(
    200,
  )
  expect((await asMember(alice, 'POST', path('remove'))).status).toBe(200)
  expect(await connectionRow(connectionId)).toBeUndefined()
  expect(
    (await database.$client`select 1 from connection_restrictions where connection_id = ${connectionId}`).length,
  ).toBe(0)
  expect(await gatewayClientNames()).not.toContain(secondName)
  expect(textOf((await mcpCall(host, token, callOf(secondName, 'lookup'))).result)).toBe(
    `${secondName} isn't available on Alice's prompts in this chat`,
  )
  expect(
    (await workspaceEventsOf(database))
      .filter(({ payload }) => payload.connectionId === connectionId)
      .map(({ type }) => type),
  ).toEqual([
    'connection.added',
    'connection.updated',
    'connection.updated',
    'connection.restricted',
    'connection.removed',
  ])
  for (const secret of ['first-secret', 'second-secret', 'third-secret'])
    expect(await everyStoredText(database)).not.toContain(secret)
})

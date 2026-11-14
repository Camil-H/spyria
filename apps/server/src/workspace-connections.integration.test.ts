import { afterAll, afterEach, expect, setDefaultTimeout, test } from 'bun:test'
import { zeroDrizzle } from '@rocicorp/zero/server/adapters/drizzle'
import { testCrmConnection } from '@spyria/db/testing'
import { schema } from '@spyria/db/zero'
import { createZeroStore } from '@spyria/db/zero-store'
import { createProfileJobs, createToolCallAccess } from '@spyria/profile/server'
import { createApp } from './app.ts'
import { startJobWorker } from './job-worker.ts'
import { sharedSecretHeader, sharedToolServer } from './testing/fake-mcp.ts'
import {
  acme,
  addLlmKey,
  alice,
  aliceInAcme,
  asMember,
  bob,
  consentThroughSpyria,
  createFakeHosts,
  everyStoredText,
  globex,
  lee,
  llmGatewayAt,
  mcpCall,
  memberMcpUrl,
  openSharedTestApp,
  openZeroStore,
  promptedBy,
  rejectionOf,
  rpcOf,
  runtimeTurn,
  sessionTokenOf,
  sharedMcpUrl,
  succeeded,
  testAuthSettings,
  textOf,
  toolConnectionSyncsSettled,
  virtualKeyOf,
  waitFor,
  workspaceEventsOf,
} from './testing/testing.ts'

setDefaultTimeout(30_000)
const { database, port, gateway, llmGateway, fakeMcp, resultOf } = await openSharedTestApp()
const { fakeHost, disconnectFakeHosts } = createFakeHosts({ port, database })
const worker = startJobWorker(database, {
  pollIntervalMilliseconds: 5,
  retryDelayMilliseconds: 100,
  cleanupRetryDelayMilliseconds: 100,
  maximumCleanupRetryDelayMilliseconds: 400,
  llmGateway,
})
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
    signIn: 'shared',
    ...(secret && { secretHeader: { name: sharedSecretHeader, value: secret } }),
  })
  expect(answer.status).toBe(201)
  return JSON.parse(answer.body) as { connectionId: string }
}
const connectionRow = async (connectionId: string) =>
  (
    await database.$client<
      { name: string; gatewayName: string; signIn: string; setupId: string | null; headerName: string | null }[]
    >`
      select name, gateway_name as "gatewayName", sign_in as "signIn", setup_id as "setupId", header_name as "headerName",
        tools, is_reviewed as "isReviewed"
      from workspace_connections where id = ${connectionId}`
  )[0]
const accessPath = (connectionId: string) => `${connectionsPath}/${connectionId}/access`
const setAccess = async (connectionId: string, subject: object, level: string | null, toolChanges = {}) =>
  (await asMember(alice, 'POST', accessPath(connectionId), { ...subject, level, toolChanges })).status
const openToEveryRole = async (connectionId: string) => {
  expect((await asMember(alice, 'POST', `${connectionsPath}/${connectionId}/review`, { markings: [] })).status).toBe(
    200,
  )
  for (const roleId of ['admin', 'member']) expect(await setAccess(connectionId, { roleId }, 'write')).toBe(200)
}
const gatewayClientNames = async () => (await llmGateway.toolServers()).map(({ name }) => name)
const grantsOf = async (userId: string) =>
  Object.fromEntries(
    (await virtualKeyOf(userId)).mcp_configs.map((config) => [config.mcp_client.name, config.tools_to_execute]),
  )
const signInsOf = async (connectionId: string) => [
  ...(await database.$client`select user_id, status from tool_connections where connection_id = ${connectionId}`),
]
const sessionsOf = async (userId: string, gatewayName: string) => {
  const server = (await llmGateway.toolServers()).find(({ name }) => name === gatewayName)
  return server ? llmGateway.toolSessions((await virtualKeyOf(userId)).id, server) : []
}
const setCrmAccess = (roleId: string, level: string | null, toolChanges = {}) =>
  setAccess('connection-crm', { roleId }, level, toolChanges)
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

test('an admin registers a shared server with a secret header: Spyria lists its tools for review, the secret reaches the server only through the gateway, never a Spyria table or read, and the event is recorded', async () => {
  const secret = `crm-secret-${crypto.randomUUID()}`
  expect(
    (await asMember(bob, 'POST', connectionsPath, { name: 'Billing', url: sharedMcpUrl, signIn: 'shared' })).status,
  ).toBe(403)
  const { connectionId } = await register('Billing', secret)
  const row = await connectionRow(connectionId)
  expect(row).toEqual({
    name: 'Billing',
    gatewayName: expect.stringMatching(/^billing_[0-9a-f]{6}$/),
    signIn: 'shared',
    setupId: null,
    headerName: sharedSecretHeader,
    tools: [
      { name: 'lookup', readOnly: true, destructive: false },
      { name: 'update', readOnly: false, destructive: false },
    ],
    isReviewed: false,
  } as never)
  expect(await gatewayClientNames()).toContain(row?.gatewayName ?? '')
  expect((await grantsOf(alice))[row?.gatewayName ?? '']).toBeUndefined()
  const addedEvent = (await workspaceEventsOf(database)).at(-1)
  await openToEveryRole(connectionId)
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
  expect(addedEvent).toEqual({
    type: 'connection.added',
    actorId: alice,
    payload: { connectionId, name: 'Billing', url: sharedMcpUrl, signIn: 'shared', hasSecret: true },
  })
})

test('a server that lists no tools is refused and left out of the gateway', async () => {
  const before = await gatewayClientNames()
  const answer = await asMember(alice, 'POST', connectionsPath, {
    name: 'Dead',
    url: 'http://host.docker.internal:9/mcp',
    signIn: 'shared',
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
test('an admin adds a server each member signs in to: their own sign-in lists its tools, then a member connects their own account and their agent calls it as them', async () => {
  const added = await asMember(alice, 'POST', connectionsPath, { name: 'Docs', url: memberMcpUrl, signIn: 'member' })
  expect(added.status).toBe(201)
  const { connectionId, authorizeUrl } = JSON.parse(added.body)
  const pending = await connectionRow(connectionId)
  expect(pending).toMatchObject({ name: 'Docs', signIn: 'member', tools: [], isReviewed: false })
  expect(pending?.setupId).not.toBeNull()
  expect((await asMember(alice, 'POST', `${connectionsPath}/${connectionId}/review`, { markings: [] })).status).toBe(
    400,
  )
  expect(await setAccess(connectionId, { roleId: 'member' }, 'write')).toBe(400)

  const gatewayName = pending?.gatewayName ?? ''

  const consent = await consentThroughSpyria(authorizeUrl, `fake_mcp_user=admin-${crypto.randomUUID()}`)
  expect(consent.status).toBe(200)
  expect((await asMember(bob, 'POST', `${connectionsPath}/${connectionId}/finish`)).status).toBe(403)
  expect((await asMember(alice, 'POST', `${connectionsPath}/${connectionId}/finish`)).status).toBe(200)
  expect(await connectionRow(connectionId)).toMatchObject({
    setupId: null,
    tools: [{ name: 'whoami', readOnly: true, destructive: false }],
    isReviewed: false,
  })
  expect(await gatewayClientNames()).toContain(gatewayName)
  expect((await workspaceEventsOf(database)).at(-1)).toEqual({
    type: 'connection.added',
    actorId: alice,
    payload: { connectionId, name: 'Docs', url: memberMcpUrl, signIn: 'member', hasSecret: false },
  })
  expect(await asMember(bob, 'POST', '/api/tool-connections/Docs/connect')).toMatchObject({ status: 400 })
  await openToEveryRole(connectionId)

  const bobAccount = `bob-${crypto.randomUUID().slice(0, 8)}`
  const started = await asMember(bob, 'POST', '/api/tool-connections/Docs/connect')
  expect(started.status).toBe(200)
  expect(
    (await consentThroughSpyria(JSON.parse(started.body).authorizeUrl, `fake_mcp_user=${bobAccount}`)).page,
  ).toContain('"connected":true')
  expect(await asMember(bob, 'POST', '/api/tool-connections/Docs/refresh')).toEqual({ status: 204, body: '' })
  await toolConnectionSyncsSettled()
  expect(await signInsOf(connectionId)).toEqual([{ user_id: bob, status: 'Connected' }])
  expect((await grantsOf(bob))[gatewayName]).toEqual(['whoami'])
  await addLlmKey(bob, 'Mistral')
  const host = await fakeHost('Member sign-in host')
  const { token } = await runtimeTurn(host, bob, bob)
  expect(textOf((await mcpCall(host, token, callOf(gatewayName, 'whoami'))).result)).toBe(`you are ${bobAccount}`)

  await fakeMcp.fetch(new Request(`http://fake-mcp/_admin/expire?user=${bobAccount}`, { method: 'POST' }))
  expect(textOf((await mcpCall(host, token, callOf(gatewayName, 'whoami'))).result)).toBe('Bob needs to reconnect Docs')
  expect((await asMember(bob, 'POST', '/api/tool-connections/check')).status).toBe(204)
  await toolConnectionSyncsSettled()
  expect(await signInsOf(connectionId)).toEqual([{ user_id: bob, status: 'Needs reconnection' }])
  expect(await setAccess(connectionId, { roleId: 'member' }, 'none')).toBe(200)
  await toolConnectionSyncsSettled()
  expect(await signInsOf(connectionId)).toEqual([])
  expect(await sessionsOf(bob, gatewayName)).toEqual([])
  await removeKeysOf(bob)

  expect((await asMember(alice, 'POST', `${connectionsPath}/${connectionId}/remove`)).status).toBe(200)
  expect((await database.$client`select 1 from tool_connections where connection_id = ${connectionId}`).length).toBe(0)
})

test('a server each member signs in to is refused with a shared secret, keeps its address, and is removed when the admin never finished signing in', async () => {
  const secretHeader = { name: sharedSecretHeader, value: 'secret' }
  expect(
    JSON.parse(
      (
        await asMember(alice, 'POST', connectionsPath, {
          name: 'Docs',
          url: memberMcpUrl,
          signIn: 'member',
          secretHeader,
        })
      ).body,
    ),
  ).toMatchObject({ error: 'invalid_connection' })
  expect(
    JSON.parse(
      (await asMember(alice, 'POST', connectionsPath, { name: 'CRM', url: sharedMcpUrl, signIn: 'shared' })).body,
    ),
  ).toEqual({ error: 'duplicate_connection_name', message: 'The catalogue already has a server named CRM' })
  expect(
    JSON.parse((await asMember(alice, 'POST', crmPath('edit'), { name: 'fake', url: sharedMcpUrl })).body),
  ).toMatchObject({ error: 'duplicate_connection_name' })
  expect(
    JSON.parse(
      (await asMember(alice, 'POST', `${connectionsPath}/connection-fake/edit`, { name: 'fake', url: sharedMcpUrl }))
        .body,
    ),
  ).toMatchObject({ error: 'invalid_connection' })

  const added = await asMember(alice, 'POST', connectionsPath, { name: 'Wiki', url: memberMcpUrl, signIn: 'member' })
  const { connectionId } = JSON.parse(added.body)
  const gatewayName = (await connectionRow(connectionId))?.gatewayName ?? ''
  expect((await asMember(alice, 'POST', `${connectionsPath}/${connectionId}/finish`)).status).toBeGreaterThanOrEqual(
    400,
  )
  expect(await connectionRow(connectionId)).toBeUndefined()
  expect(await gatewayClientNames()).not.toContain(gatewayName)
})

test('a member whose role is given Read is refused update on their own prompts, their key holds exactly lookup, and the key kept after the last LLM key is removed keeps that access', async () => {
  expect(await setCrmAccess('member', 'read')).toBe(200)
  await addLlmKey(bob, 'Mistral')
  expect((await grantsOf(bob))[sharedToolServer]).toEqual(['lookup'])

  const host = await fakeHost('Read member host')
  const { token } = await runtimeTurn(host, bob, bob)
  expect(textOf((await mcpCall(host, token, callOf(sharedToolServer, 'lookup'))).result)).toBe('ran lookup')
  expect(textOf((await mcpCall(host, token, callOf(sharedToolServer, 'update'))).result)).toBe(
    `Bob's access to ${testCrmConnection.name} does not include update in this chat`,
  )

  const keyBefore = (await virtualKeyOf(bob)).id
  await removeKeysOf(bob)
  expect((await virtualKeyOf(bob)).id).toBe(keyBefore)
  expect((await grantsOf(bob))[sharedToolServer]).toEqual(['lookup'])
  expect(textOf((await mcpCall(host, token, callOf(sharedToolServer, 'lookup'))).result)).toBe('ran lookup')
  await addLlmKey(bob, 'Mistral')
  expect((await virtualKeyOf(bob)).id).toBe(keyBefore)
  expect(textOf((await mcpCall(host, token, callOf(sharedToolServer, 'update'))).result)).toBe(
    `Bob's access to ${testCrmConnection.name} does not include update in this chat`,
  )

  expect(await setCrmAccess('member', 'none')).toBe(200)
  expect((await grantsOf(bob))[sharedToolServer]).toBeUndefined()
  expect(await setCrmAccess('member', null)).toBe(200)
  expect((await grantsOf(bob))[sharedToolServer]).toBeUndefined()
  expect(await setCrmAccess('member', 'write')).toBe(200)
  expect((await grantsOf(bob))[sharedToolServer]).toEqual(['lookup', 'update'])
  expect(await setCrmAccess('member', 'read', { delete: true })).toBe(400)
  expect(await setCrmAccess('member', 'everything')).toBe(400)
  expect(
    (
      await asMember(bob, 'POST', accessPath('connection-crm'), {
        roleId: 'member',
        level: 'write',
        toolChanges: {},
      })
    ).status,
  ).toBe(403)
  expect(
    (await workspaceEventsOf(database))
      .filter(({ type, payload }) => type === 'connection.access_changed' && payload.connectionId === 'connection-crm')
      .map(({ payload }) => payload),
  ).toEqual([
    { connectionId: 'connection-crm', roleId: 'member', level: 'read', toolChanges: {} },
    { connectionId: 'connection-crm', roleId: 'member', level: 'none', toolChanges: {} },
    { connectionId: 'connection-crm', roleId: 'member', level: null, toolChanges: {} },
    { connectionId: 'connection-crm', roleId: 'member', level: 'write', toolChanges: {} },
  ])
})

test('a review and level changes sent together leave every member with the tools of the last change, never an earlier snapshot', async () => {
  await addLlmKey(bob, 'Mistral')
  const { connectionId } = await register('Ledger')
  const { gatewayName } = (await connectionRow(connectionId)) ?? { gatewayName: '' }
  const answers = await Promise.all([
    asMember(alice, 'POST', `${connectionsPath}/${connectionId}/review`, { markings: [] }),
    setAccess(connectionId, { roleId: 'admin' }, 'write'),
    setAccess(connectionId, { roleId: 'member' }, 'read'),
  ])
  expect(answers.map((answer) => (typeof answer === 'number' ? answer : answer.status))).toEqual([200, 200, 200])
  expect((await grantsOf(alice))[gatewayName]).toEqual(['lookup', 'update'])
  expect((await grantsOf(bob))[gatewayName]).toEqual(['lookup'])
  await removeKeysOf(bob)
  expect((await asMember(alice, 'POST', `${connectionsPath}/${connectionId}/remove`)).status).toBe(200)
})

test("a role's level and single-tool changes reach every member of the role, a later change keeps the earlier ones, and a member whose role changes gets the new role's tools", async () => {
  await addLlmKey(bob, 'openai')
  try {
    expect(await setAccess('connection-crm', { roleId: 'member' }, 'none', { update: true })).toBe(200)
    expect((await grantsOf(bob))[sharedToolServer]).toEqual(['update'])
    expect(await setAccess('connection-crm', { roleId: 'member' }, 'read')).toBe(200)
    expect((await grantsOf(bob))[sharedToolServer]).toEqual(['lookup', 'update'])
    expect(await setAccess('connection-crm', { roleId: 'member' }, 'read', { update: false })).toBe(200)
    expect((await grantsOf(bob))[sharedToolServer]).toEqual(['lookup'])

    expect(await setAccess('connection-crm', { roleId: 'nobody' }, 'read')).toBe(400)

    expect(
      await resultOf(aliceInAcme, 'workspace.changeMemberRole', { workspaceId: acme, memberId: bob, role: 'admin' }),
    ).toEqual(succeeded)
    await waitFor(async () => (await grantsOf(bob))[sharedToolServer]?.length === 2)
    expect((await grantsOf(bob))[sharedToolServer]).toEqual(['lookup', 'update'])
  } finally {
    await resultOf(aliceInAcme, 'workspace.changeMemberRole', { workspaceId: acme, memberId: bob, role: 'member' })
    await setAccess('connection-crm', { roleId: 'member' }, 'write')
  }
})

test('a member moved to a role without access to a server they signed in to loses that sign-in', async () => {
  expect(await setAccess('connection-fake', { roleId: 'admin' }, 'none')).toBe(200)
  try {
    const started = await asMember(bob, 'POST', '/api/tool-connections/fake/connect')
    expect(started.status).toBe(200)
    expect(
      (await consentThroughSpyria(JSON.parse(started.body).authorizeUrl, `fake_mcp_user=bob-${crypto.randomUUID()}`))
        .page,
    ).toContain('"connected":true')
    expect((await asMember(bob, 'POST', '/api/tool-connections/fake/refresh')).status).toBe(204)
    await toolConnectionSyncsSettled()
    expect(await signInsOf('connection-fake')).toEqual([{ user_id: bob, status: 'Connected' }])

    expect(
      await resultOf(aliceInAcme, 'workspace.changeMemberRole', { workspaceId: acme, memberId: bob, role: 'admin' }),
    ).toEqual(succeeded)
    await waitFor(async () => (await signInsOf('connection-fake')).length === 0)
    expect(await sessionsOf(bob, 'fake')).toEqual([])
  } finally {
    await resultOf(aliceInAcme, 'workspace.changeMemberRole', { workspaceId: acme, memberId: bob, role: 'member' })
    await setAccess('connection-fake', { roleId: 'admin' }, 'write')
  }
})

test("every member reads the access of every role of their workspace, and a role's change syncs to each of them", async () => {
  expect(await setCrmAccess('admin', 'read', { update: true })).toBe(200)
  try {
    const adminAccess = {
      connectionId: 'connection-crm',
      roleId: 'admin',
      level: 'read',
      toolChanges: { update: true },
    }
    const crmAccessOf = async (userId: string) => {
      const store = await openZeroStore(createZeroStore, userId as never, [acme])
      const accessRows = () =>
        store
          .read()
          .connectionAccess.filter(({ connectionId }) => connectionId === 'connection-crm')
          .map(({ connectionId, roleId, level, toolChanges }) => ({ connectionId, roleId, level, toolChanges }))
      await waitFor(() => accessRows().some((row) => row.roleId === 'admin' && row.level === 'read'))
      return accessRows()
    }
    for (const userId of [alice, bob, lee])
      expect(await crmAccessOf(userId)).toEqual(
        expect.arrayContaining([
          adminAccess,
          { connectionId: 'connection-crm', roleId: 'member', level: 'write', toolChanges: {} },
        ]),
      )
  } finally {
    await setCrmAccess('admin', 'write')
  }
})

test('the admin’s review of what each tool does decides what Read grants, and only an admin reviews', async () => {
  const review = (userId: string, markings: object[]) => asMember(userId, 'POST', crmPath('review'), { markings })
  expect(await setCrmAccess('admin', 'read')).toBe(200)
  try {
    expect((await grantsOf(alice))[sharedToolServer]).toEqual(['lookup'])
    expect((await review(alice, [{ name: 'update', readOnly: true }])).status).toBe(200)
    expect((await grantsOf(alice))[sharedToolServer]).toEqual(['lookup', 'update'])
    const host = await fakeHost('Reviewed tools host')
    const { token } = await runtimeTurn(host, alice)
    expect(textOf((await mcpCall(host, token, callOf(sharedToolServer, 'update'))).result)).toBe('ran update')
    expect((await review(bob, [{ name: 'update', readOnly: false }])).status).toBe(403)
    expect((await review(alice, [{ name: 'drop', readOnly: true }])).status).toBe(400)
    expect((await workspaceEventsOf(database)).at(-1)).toEqual({
      type: 'connection.reviewed',
      actorId: alice,
      payload: { connectionId: 'connection-crm', readTools: ['lookup', 'update'] },
    })
  } finally {
    await review(alice, [{ name: 'update', readOnly: false }])
    await setCrmAccess('admin', 'write')
  }
})

test('a workspace’s connections are never granted to, listed for or callable by another workspace’s member', async () => {
  const { connectionId } = await register('Ledger')
  await openToEveryRole(connectionId)
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
  const access = createToolCallAccess((work) => zeroDrizzle(schema, database).transaction(work), llmGateway)
  expect(await access.toolCallPolicy(globex, alice, alice, `${gatewayName}-lookup`)).toMatchObject({
    access: 'not_granted',
  })
  expect(await access.toolCallPolicy(acme, alice, alice, `${gatewayName}-lookup`)).toEqual({
    access: 'allowed',
    readOnly: true,
    approval: 'never',
    answerer: 'owner',
  })
})

test('editing replaces the secret in place, a new URL registers the server again and regrants it, and removing deletes it from the gateway and Spyria', async () => {
  const { connectionId } = await register('Orders', 'first-secret')
  await openToEveryRole(connectionId)
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

  expect(await setAccess(connectionId, { roleId: 'member' }, 'read')).toBe(200)
  expect((await asMember(alice, 'POST', path('remove'))).status).toBe(200)
  expect(await connectionRow(connectionId)).toBeUndefined()
  expect((await database.$client`select 1 from connection_access where connection_id = ${connectionId}`).length).toBe(0)
  expect(await gatewayClientNames()).not.toContain(secondName)
  expect(textOf((await mcpCall(host, token, callOf(secondName, 'lookup'))).result)).toBe(
    `Alice's access to ${secondName} does not include lookup in this chat`,
  )
  expect(
    (await workspaceEventsOf(database))
      .filter(({ payload }) => payload.connectionId === connectionId)
      .map(({ type }) => type),
  ).toEqual([
    'connection.added',
    'connection.reviewed',
    'connection.access_changed',
    'connection.access_changed',
    'connection.updated',
    'connection.updated',
    'connection.access_changed',
    'connection.removed',
  ])
  for (const secret of ['first-secret', 'second-secret', 'third-secret'])
    expect(await everyStoredText(database)).not.toContain(secret)
})

test('a running agent’s MCP stream hears that its tool list changed when a connection is added, opened, narrowed or removed, and its next listing has the change', async () => {
  const host = await fakeHost('Tool list changes host')
  const { token } = await runtimeTurn(host, alice)
  const streamed: string[] = []
  const opened = Promise.withResolvers<number | undefined>()
  const closing = new AbortController()
  const stream = host.modelCall({
    method: 'GET',
    path: '/mcp',
    headers: { authorization: `Bearer ${token}`, accept: 'text/event-stream' },
    onHead: opened.resolve,
    onChunk: (data) => streamed.push(data),
    signal: closing.signal,
  })
  expect(await opened.promise).toBe(200)
  const changeCount = () => streamed.filter((data) => data.includes('"notifications/tools/list_changed"')).length
  const listedNames = async () =>
    ((await mcpCall(host, token, rpcOf('tools/list'))).result.tools as { name: string }[]).map(({ name }) => name)

  const { connectionId } = await register('Orders')
  const gatewayName = (await connectionRow(connectionId))?.gatewayName ?? ''
  await waitFor(() => changeCount() >= 1)
  expect((await listedNames()).filter((name) => name.startsWith(`${gatewayName}-`))).toEqual([])

  await openToEveryRole(connectionId)
  await waitFor(() => changeCount() >= 4)
  expect(await listedNames()).toContain(`${gatewayName}-update`)

  const ordersPath = (action: string) => `${connectionsPath}/${connectionId}/${action}`
  const beforeNarrowing = changeCount()
  expect(await setAccess(connectionId, { roleId: 'admin' }, 'read')).toBe(200)
  await waitFor(() => changeCount() > beforeNarrowing)
  expect(await listedNames()).toContain(`${gatewayName}-lookup`)
  expect(await listedNames()).not.toContain(`${gatewayName}-update`)

  const beforeRemoving = changeCount()
  expect((await asMember(alice, 'POST', ordersPath('remove'))).status).toBe(200)
  await waitFor(() => changeCount() > beforeRemoving)
  expect((await listedNames()).filter((name) => name.startsWith(`${gatewayName}-`))).toEqual([])
  closing.abort()
  await stream
})

test('a tool server switched off in a chat leaves its agent’s list while the others stay, its calls are refused and recorded, and switching it on brings it back', async () => {
  const host = await fakeHost('Chat tool switch host')
  const { chatId, token } = await runtimeTurn(host, alice)
  const [ledger, billing] = [await register('Payroll'), await register('Invoicing')]
  await openToEveryRole(ledger.connectionId)
  await openToEveryRole(billing.connectionId)
  const ledgerName = (await connectionRow(ledger.connectionId))?.gatewayName ?? ''
  const billingName = (await connectionRow(billing.connectionId))?.gatewayName ?? ''
  const streamed: string[] = []
  const opened = Promise.withResolvers<number | undefined>()
  const closing = new AbortController()
  const stream = host.modelCall({
    method: 'GET',
    path: '/mcp',
    headers: { authorization: `Bearer ${token}`, accept: 'text/event-stream' },
    onHead: opened.resolve,
    onChunk: (data) => streamed.push(data),
    signal: closing.signal,
  })
  expect(await opened.promise).toBe(200)
  const changeCount = () => streamed.filter((data) => data.includes('"notifications/tools/list_changed"')).length
  const listedServers = async () =>
    ((await mcpCall(host, token, rpcOf('tools/list'))).result.tools as { name: string }[]).map(
      ({ name }) => name.split('-')[0],
    )
  const switchLedger = (isOn: boolean) =>
    resultOf(aliceInAcme, 'conversation.switchChatToolServer', {
      workspaceId: acme,
      chatId,
      connectionId: ledger.connectionId,
      isOn,
    })
  expect(await listedServers()).toEqual(expect.arrayContaining([ledgerName, billingName]))

  const beforeOff = changeCount()
  expect(await switchLedger(false)).toEqual(succeeded)
  await waitFor(() => changeCount() > beforeOff)
  expect(await listedServers()).not.toContain(ledgerName)
  expect(await listedServers()).toContain(billingName)
  const refused = await mcpCall(host, token, rpcOf('tools/call', { name: `${ledgerName}-lookup`, arguments: {} }))
  expect(refused.result).toMatchObject({ isError: true })
  expect(textOf(refused.result)).toBe('Payroll is off for this chat')
  const billed = await mcpCall(host, token, rpcOf('tools/call', { name: `${billingName}-lookup`, arguments: {} }))
  expect(textOf(billed.result)).toBe('ran lookup')
  const recordedCalls = async () => [
    ...(await database.$client`select server, tool, status from tool_calls where chat_id = ${chatId} order by called_at`),
  ]
  await waitFor(async () => (await recordedCalls()).length === 2)
  expect(await recordedCalls()).toEqual([
    { server: ledgerName, tool: 'lookup', status: 'refused' },
    { server: billingName, tool: 'lookup', status: 'succeeded' },
  ])

  const beforeOn = changeCount()
  expect(await switchLedger(true)).toEqual(succeeded)
  await waitFor(() => changeCount() > beforeOn)
  expect(await listedServers()).toEqual(expect.arrayContaining([ledgerName, billingName]))
  closing.abort()
  await stream
})

test('the agent lists the tools of the member who prompted, so a guest’s turn lists their own access and not the owner’s', async () => {
  const { connectionId } = await register('Tickets')
  await openToEveryRole(connectionId)
  const gatewayName = (await connectionRow(connectionId))?.gatewayName ?? ''
  const host = await fakeHost('Prompter listing host')
  const { chatId, token } = await runtimeTurn(host, alice)
  const ticketTools = async () =>
    ((await mcpCall(host, token, rpcOf('tools/list'))).result.tools as { name: string }[])
      .map(({ name }) => name)
      .filter((name) => name.startsWith(`${gatewayName}-`))
  try {
    expect(await setAccess(connectionId, { roleId: 'member' }, 'none')).toBe(200)
    await waitFor(async () => (await ticketTools()).length > 0)
    await promptedBy(chatId, bob)
    await waitFor(async () => (await ticketTools()).length === 0)
  } finally {
    await asMember(alice, 'POST', `${connectionsPath}/${connectionId}/remove`)
  }
})

const grantRefusingGateway = () =>
  Bun.serve({
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url)
      const body = request.method === 'GET' || request.method === 'DELETE' ? undefined : await request.text()
      if (request.method === 'PUT' && body?.includes('"mcp_configs"')) return new Response('down', { status: 503 })
      return fetch(`${gateway.url}${url.pathname}${url.search}`, {
        method: request.method,
        headers: request.headers,
        body,
      })
    },
  })

test("taking a role's access away while the gateway refuses grants succeeds, and a queued gateway sync removes the tools from each member's key once it answers", async () => {
  expect(await setCrmAccess('member', 'write')).toBe(200)
  await addLlmKey(bob, 'Mistral')
  expect((await grantsOf(bob))[sharedToolServer]).toEqual(['lookup', 'update'])
  const refusingGateway = grantRefusingGateway()
  try {
    const appWithRefusedGrants = createApp({
      database,
      ...testAuthSettings,
      llmGateway: llmGatewayAt(refusingGateway.url.origin),
    })
    const revoked = await appWithRefusedGrants.request(accessPath('connection-crm'), {
      method: 'POST',
      headers: { authorization: `Bearer ${await sessionTokenOf(database, acme, alice)}` },
      body: JSON.stringify({ roleId: 'member', level: 'none', toolChanges: {} }),
    })
    expect(revoked.status).toBe(200)
    await waitFor(async () => (await grantsOf(bob))[sharedToolServer] === undefined)
  } finally {
    void refusingGateway.stop(true)
    await setCrmAccess('member', null)
  }
})

test('a gateway sync whose tool grant the gateway refuses fails, so the job worker retries it instead of leaving the grant as it was', async () => {
  await addLlmKey(bob, 'Mistral')
  expect(await setCrmAccess('member', 'write')).toBe(200)
  expect((await grantsOf(bob))[sharedToolServer]).toEqual(['lookup', 'update'])
  await database.$client`
    update connection_access set level = 'none'
    where workspace_id = ${acme} and connection_id = 'connection-crm' and role_id = 'member'`
  const refusingGateway = grantRefusingGateway()
  try {
    const jobs = createProfileJobs(llmGatewayAt(refusingGateway.url.origin))
    const sync = jobs['profile.gateway-sync']({
      workspaceId: acme,
      payload: { memberId: bob },
      isLastAttempt: false,
      transact: (work) => zeroDrizzle(schema, database).transaction(work),
    })
    expect(String(await rejectionOf(sync))).toContain('The gateway answered PUT')
  } finally {
    void refusingGateway.stop(true)
    await setCrmAccess('member', null)
  }
})

import { afterAll, expect, spyOn, test } from 'bun:test'
import { createApp } from './app.ts'
import { startJobWorker } from './job-worker.ts'
import {
  acme,
  alice,
  aliceInAcme,
  failedWith,
  globex,
  llmGatewayAt,
  openSharedTestApp,
  bob,
  bobInAcme,
  sessionTokenOf,
  succeeded,
  testAuthSettings,
  waitFor,
} from './testing.ts'

const { database, app, gateway, llmGateway, resultOf } = await openSharedTestApp()
const worker = startJobWorker(database, { pollIntervalMilliseconds: 5, retryDelayMilliseconds: 100, llmGateway })
afterAll(() => worker.stop())
const tokenOf = (workspaceId: string, userId: string) => sessionTokenOf(database, workspaceId, userId)
const secretValue = 'sk-integration-secret-4321'

const postCredential = async (authorization: string, body: string, through = app) => {
  const response = await through.request('/api/llm-credentials', { method: 'POST', headers: { authorization }, body })
  return { status: response.status, text: await response.text() }
}
const postCredentialAs = async (member: typeof aliceInAcme, body: object, through = app) =>
  postCredential(`Bearer ${await tokenOf(member.workspaceId, member.userId)}`, JSON.stringify(body), through)

const credentialRows = () => database.$client`select * from llm_credentials order by id`
const gatewayKeyOf = (row: { secret_ref: string } | undefined) => {
  const [, provider, id] = String(row?.secret_ref).match(/^gateway:([a-z]+)\/(.+)$/) ?? []
  return { provider: provider ?? '', id: id ?? '' }
}
const gatewayKeysOf = async (provider: string) =>
  (await gateway.call<{ keys: { id: string; name: string }[] }>(`/api/providers/${provider}/keys`)).keys
const virtualKeyIdOf = async (userId: string) =>
  (await database.$client`select virtual_key_id from member_gateway_keys where user_id = ${userId}`)[0]?.virtual_key_id
const boundKeyIdsOf = async (virtualKeyId: string) =>
  (
    await gateway.call<{ virtual_key: { provider_configs: { keys: { key_id: string }[] }[] } }>(
      `/api/governance/virtual-keys/${virtualKeyId}`,
    )
  ).virtual_key.provider_configs
    .flatMap((config) => config.keys.map((key) => key.key_id))
    .toSorted()
const everyStoredText = async () => {
  const tables = await database.$client<{ name: string }[]>`
    select table_name as name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE'`
  const rows = await Promise.all(tables.map(({ name }) => database.$client.unsafe(`select * from "${name}"`)))
  return JSON.stringify(rows)
}
const connectionsOf = (userId: string) =>
  database.query.toolConnections.findMany({ where: { workspaceId: acme, userId }, orderBy: { position: 'asc' } })
const consoleSpies = () => (['log', 'info', 'warn', 'error', 'debug'] as const).map((method) => spyOn(console, method))
const loggedText = (spies: ReturnType<typeof consoleSpies>) =>
  spies.map((spy) => Bun.inspect(spy.mock.calls)).join('\n')
const restore = (spies: ReturnType<typeof consoleSpies>) => {
  for (const spy of spies) spy.mockRestore()
}
const appWithGateway = (url: string) => createApp({ database, ...testAuthSettings, llmGateway: llmGatewayAt(url) })
const failingVirtualKeysProxy = () =>
  Bun.serve({
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url)
      if (url.pathname.startsWith('/api/governance/virtual-keys')) return new Response('down', { status: 503 })
      return fetch(`${gateway.url}${url.pathname}${url.search}`, {
        method: request.method,
        headers: request.headers,
        body: request.method === 'GET' || request.method === 'DELETE' ? undefined : await request.text(),
      })
    },
  })

test('the credential endpoint refuses blank, missing, malformed or unsupported fields and stores nothing', async () => {
  const token = `Bearer ${await tokenOf(acme, alice)}`
  const keysBefore = await gatewayKeysOf('openai')
  for (const body of [
    { provider: '  ', secret: secretValue },
    { provider: 'OpenAI', secret: '  ' },
    { provider: 'OpenAI' },
    { secret: secretValue },
    { provider: 42, secret: secretValue },
  ])
    expect((await postCredential(token, JSON.stringify(body))).status).toBe(400)
  expect(await postCredential(token, 'not json')).toMatchObject({ status: 400 })
  expect(await postCredential(token, JSON.stringify({ provider: 'Foo', secret: secretValue }))).toEqual({
    status: 400,
    text: JSON.stringify({ error: 'unsupported_provider', message: 'Foo is not a supported provider' }),
  })
  expect(await credentialRows()).toHaveLength(1)
  expect(await gatewayKeysOf('openai')).toEqual(keysBefore)
})

test('adding a credential stores the secret in the gateway under an opaque name, binds it to the member virtual key, and HQ keeps no secret and logs nothing', async () => {
  const spies = consoleSpies()
  try {
    const response = await postCredentialAs(aliceInAcme, { provider: ' OpenAI ', secret: secretValue })
    expect(response).toEqual({ status: 201, text: '' })
    expect(loggedText(spies)).not.toContain(secretValue)
  } finally {
    restore(spies)
  }
  const rows = await credentialRows()
  const stored = rows.find((row) => row.provider === 'OpenAI')
  const seeded = rows.find((row) => row.provider === 'Anthropic')
  expect(stored).toMatchObject({ workspace_id: acme, user_id: alice, last4: '4321' })
  const key = gatewayKeyOf(stored as { secret_ref: string })
  expect(key.provider).toBe('openai')
  const [gatewayKey] = (await gatewayKeysOf('openai')).filter(({ id }) => id === key.id)
  expect(gatewayKey?.name).toMatch(/^cred_[0-9a-f-]{36}$/)
  const virtualKeyId = await virtualKeyIdOf(alice)
  expect(await boundKeyIdsOf(virtualKeyId)).toEqual(
    [key.id, gatewayKeyOf(seeded as { secret_ref: string }).id].toSorted(),
  )
  const { virtual_key } = await gateway.call<{ virtual_key: { name: string; value: string } }>(
    `/api/governance/virtual-keys/${virtualKeyId}`,
  )
  expect(virtual_key.name).not.toMatch(/alice/i)
  const storedText = await everyStoredText()
  expect(storedText).not.toContain(secretValue)
  expect(storedText).not.toContain(virtual_key.value)
})

test('the secret never reaches a replicated table or column', async () => {
  const publishedTables = await database.$client<{ table: string; columns: string[] }[]>`
    select tablename as table, attnames as columns from pg_publication_tables where pubname = 'hq_zero'`
  expect(publishedTables.map(({ table }) => table)).not.toContain('member_gateway_keys')
  expect(publishedTables.find(({ table }) => table === 'llm_credentials')?.columns).not.toContain('secret_ref')
  expect(publishedTables.find(({ table }) => table === 'chats')?.columns).not.toContain('agent_turn_prompter_id')
  expect(publishedTables.find(({ table }) => table === 'chats')?.columns).not.toContain('agent_turn_failure')
  expect(publishedTables.find(({ table }) => table === 'runtimes')?.columns).not.toContain('llm_token_hash')
  for (const { table, columns } of publishedTables) {
    const rows = await database.$client.unsafe(
      `select ${columns.map((column) => `"${column}"`).join(', ')} from "${table}"`,
    )
    expect({ table, leaks: JSON.stringify(rows).includes(secretValue) }).toEqual({ table, leaks: false })
  }
})

test('an unreachable gateway leaves no row and logs no secret', async () => {
  const spies = consoleSpies()
  try {
    expect(
      await postCredentialAs(
        bobInAcme,
        { provider: 'Mistral', secret: secretValue },
        appWithGateway('http://127.0.0.1:9'),
      ),
    ).toMatchObject({ status: 500 })
    expect(loggedText(spies)).not.toContain(secretValue)
  } finally {
    restore(spies)
  }
  expect((await credentialRows()).filter((row) => row.user_id === bob)).toEqual([])
  expect(await virtualKeyIdOf(bob)).toBeUndefined()
})

test('a failed HQ commit deletes the gateway key it just created and logs no secret', async () => {
  const keysBefore = await gatewayKeysOf('mistral')
  await database.$client`alter table llm_credentials add constraint refuse_provider check (provider <> 'Mistral') not valid`
  const spies = consoleSpies()
  try {
    expect(await postCredentialAs(bobInAcme, { provider: 'Mistral', secret: 'sk-refused-value' })).toMatchObject({
      status: 500,
    })
    expect(loggedText(spies)).not.toContain('sk-refused-value')
  } finally {
    restore(spies)
    await database.$client`alter table llm_credentials drop constraint refuse_provider`
  }
  expect((await credentialRows()).map((row) => row.provider)).not.toContain('Mistral')
  expect(await gatewayKeysOf('mistral')).toEqual(keysBefore)
  expect(await virtualKeyIdOf(bob)).toBeUndefined()
})

test('a failed virtual key write removes the new row and its gateway key, and keeps the member key as it was', async () => {
  const keysBefore = await gatewayKeysOf('mistral')
  const virtualKeyId = await virtualKeyIdOf(alice)
  const boundBefore = await boundKeyIdsOf(virtualKeyId)
  const proxy = failingVirtualKeysProxy()
  try {
    expect(
      await postCredentialAs(
        aliceInAcme,
        { provider: 'Mistral', secret: secretValue },
        appWithGateway(proxy.url.origin),
      ),
    ).toMatchObject({ status: 500 })
  } finally {
    void proxy.stop(true)
  }
  expect((await credentialRows()).map((row) => row.provider)).not.toContain('Mistral')
  expect(await gatewayKeysOf('mistral')).toEqual(keysBefore)
  expect(await virtualKeyIdOf(alice)).toBe(virtualKeyId)
  expect(await boundKeyIdsOf(virtualKeyId)).toEqual(boundBefore)
})

test('a member cannot remove the credential of another member; removing one unbinds and deletes its gateway key, removing the last deletes the virtual key', async () => {
  const rows = await credentialRows()
  const [openAi] = rows.filter((row) => row.provider === 'OpenAI')
  const [seeded] = rows.filter((row) => row.provider === 'Anthropic')
  const removal = { workspaceId: acme, credentialId: openAi?.id, memberId: alice }
  expect(await resultOf(bobInAcme, 'profile.removeLlmCredential', removal)).toEqual(
    failedWith(`LLM credential ${openAi?.id} was not found`),
  )
  expect(await credentialRows()).toHaveLength(2)

  const virtualKeyId = await virtualKeyIdOf(alice)
  const openAiKey = gatewayKeyOf(openAi as { secret_ref: string })
  const seededKey = gatewayKeyOf(seeded as { secret_ref: string })
  expect(await resultOf(aliceInAcme, 'profile.removeLlmCredential', removal)).toEqual(succeeded)
  expect((await credentialRows()).map((row) => row.provider)).toEqual(['Anthropic'])
  await waitFor(async () => (await gateway.request(`/api/providers/openai/keys/${openAiKey.id}`)).status === 404)
  expect(await boundKeyIdsOf(virtualKeyId)).toEqual([seededKey.id])

  expect(
    await resultOf(aliceInAcme, 'profile.removeLlmCredential', { workspaceId: acme, credentialId: seeded?.id }),
  ).toEqual(succeeded)
  await waitFor(async () => (await gateway.request(`/api/governance/virtual-keys/${virtualKeyId}`)).status === 404)
  await waitFor(async () => (await gateway.request(`/api/providers/fake/keys/${seededKey.id}`)).status === 404)
  expect(await virtualKeyIdOf(alice)).toBeUndefined()
  expect([...(await database.$client`select state from jobs where type = 'profile.gateway-sync'`)]).toEqual([
    { state: 'done' },
    { state: 'done' },
  ])
})

test('renameMember changes the display name of the member in the current workspace only', async () => {
  expect(
    await resultOf(aliceInAcme, 'profile.renameMember', { workspaceId: acme, name: ' Alice D. ', memberId: bob }),
  ).toEqual(succeeded)
  const names = await database.query.memberships.findMany({ orderBy: { workspaceId: 'asc', userId: 'asc' } })
  expect(names.map(({ workspaceId, userId, displayName }) => [workspaceId, userId, displayName])).toEqual([
    [acme, alice, 'Alice D.'],
    [acme, bob, 'Bob'],
    [globex, alice, 'Alice'],
  ])
  expect(await resultOf(aliceInAcme, 'profile.renameMember', { workspaceId: globex, name: 'Other' })).toEqual(
    failedWith('A member can only change their own profile in their current workspace'),
  )
})

test('connectTool appends at the next position, reconnects in place and disconnectTool removes', async () => {
  const toolsOf = async (userId: string) =>
    (await connectionsOf(userId)).map(({ tool, status, position }) => [tool, status, position])
  expect(await resultOf(aliceInAcme, 'profile.connectTool', { workspaceId: acme, tool: 'Linear' })).toEqual(succeeded)
  expect(await resultOf(aliceInAcme, 'profile.connectTool', { workspaceId: acme, tool: 'Notion' })).toEqual(succeeded)
  expect(await resultOf(aliceInAcme, 'profile.disconnectTool', { workspaceId: acme, tool: 'GitHub' })).toEqual(
    succeeded,
  )
  expect(await resultOf(aliceInAcme, 'profile.connectTool', { workspaceId: acme, tool: 'GitHub' })).toEqual(succeeded)
  expect(await toolsOf(alice)).toEqual([
    ['Slack', 'Connected', 2],
    ['Notion', 'Connected', 3],
    ['Linear', 'Connected', 4],
    ['GitHub', 'Connected', 5],
  ])
  expect(await resultOf(aliceInAcme, 'profile.connectTool', { workspaceId: acme, tool: 'Jira' })).toEqual(
    failedWith('Tool Jira is not in the catalog'),
  )
})

test('concurrent connects of a member get distinct positions and never touch another member', async () => {
  const results = await Promise.all(
    ['GitHub', 'Slack', 'Notion', 'Linear'].map((tool) =>
      resultOf(bobInAcme, 'profile.connectTool', { workspaceId: acme, tool, memberId: alice }),
    ),
  )
  expect(results).toEqual([succeeded, succeeded, succeeded, succeeded])
  expect((await connectionsOf(bob)).map(({ position }) => position)).toEqual([1, 2, 3, 4])
  expect(await connectionsOf(alice)).toHaveLength(4)
  for (const tool of ['GitHub', 'Slack', 'Notion', 'Linear'])
    await resultOf(bobInAcme, 'profile.disconnectTool', { workspaceId: acme, tool })
  expect(await connectionsOf(bob)).toEqual([])
})

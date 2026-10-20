import { afterAll, describe, expect, test } from 'bun:test'
import { createApp } from './app.ts'
import { startJobWorker } from './job-worker.ts'
import {
  acme,
  alice,
  aliceInAcme,
  bob,
  bobInAcme,
  captureConsole,
  everyStoredText,
  failedWith,
  globex,
  lee,
  llmGatewayAt,
  openSharedTestApp,
  sessionTokenOf,
  succeeded,
  testAuthSettings,
  waitFor,
} from './testing/testing.ts'

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

describe('Alice’s OpenAI credential, added then removed', () => {
  test('adding a credential stores the secret in the gateway under an opaque name, binds it to the member virtual key, and Spyria keeps no secret and logs nothing', async () => {
    const consoleCalls = captureConsole()
    try {
      const response = await postCredentialAs(aliceInAcme, { provider: ' OpenAI ', secret: secretValue })
      expect(response).toEqual({ status: 201, text: '' })
      expect(consoleCalls.logged()).not.toContain(secretValue)
    } finally {
      consoleCalls.restore()
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
    const storedText = await everyStoredText(database)
    expect(storedText).not.toContain(secretValue)
    expect(storedText).not.toContain(virtual_key.value)
  })

  test('the secret never reaches a replicated row', async () => {
    const publishedTables = await database.$client<{ table: string; columns: string[] }[]>`
    select tablename as table, attnames as columns from pg_publication_tables where pubname = 'spyria_zero'`
    for (const { table, columns } of publishedTables) {
      const rows = await database.$client.unsafe(
        `select ${columns.map((column) => `"${column}"`).join(', ')} from "${table}"`,
      )
      expect({ table, leaks: JSON.stringify(rows).includes(secretValue) }).toEqual({ table, leaks: false })
    }
  })

  test('an unreachable gateway leaves no row and logs no secret', async () => {
    const consoleCalls = captureConsole()
    try {
      expect(
        await postCredentialAs(
          bobInAcme,
          { provider: 'Mistral', secret: secretValue },
          appWithGateway('http://127.0.0.1:9'),
        ),
      ).toMatchObject({ status: 500 })
      expect(consoleCalls.logged()).not.toContain(secretValue)
    } finally {
      consoleCalls.restore()
    }
    expect((await credentialRows()).filter((row) => row.user_id === bob)).toEqual([])
    expect(await virtualKeyIdOf(bob)).toBeUndefined()
  })

  test('a failed Spyria commit deletes the gateway key it just created and logs no secret', async () => {
    const keysBefore = await gatewayKeysOf('mistral')
    await database.$client`alter table llm_credentials add constraint refuse_provider check (provider <> 'Mistral') not valid`
    const consoleCalls = captureConsole()
    try {
      expect(await postCredentialAs(bobInAcme, { provider: 'Mistral', secret: 'sk-refused-value' })).toMatchObject({
        status: 500,
      })
      expect(consoleCalls.logged()).not.toContain('sk-refused-value')
    } finally {
      consoleCalls.restore()
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
    const gatewaySyncStates = async () => [
      ...(await database.$client`select state from jobs where type = 'profile.gateway-sync'`),
    ]
    await waitFor(async () => (await gatewaySyncStates()).every(({ state }) => !['queued', 'running'].includes(state)))
    expect(await gatewaySyncStates()).toEqual([{ state: 'done' }, { state: 'done' }])
  })
})

test('renameMember changes the display name of the member in the current workspace only', async () => {
  expect(
    await resultOf(aliceInAcme, 'profile.renameMember', { workspaceId: acme, name: ' Alice D. ', memberId: bob }),
  ).toEqual(succeeded)
  const names = await database.query.memberships.findMany({ orderBy: { workspaceId: 'asc', userId: 'asc' } })
  expect(names.map(({ workspaceId, userId, displayName }) => [workspaceId, userId, displayName])).toEqual([
    [acme, alice, 'Alice D.'],
    [acme, bob, 'Bob'],
    [acme, lee, 'Lee'],
    [globex, alice, 'Alice'],
  ])
  expect(await resultOf(aliceInAcme, 'profile.renameMember', { workspaceId: globex, name: 'Other' })).toEqual(
    failedWith('A member can only change their own profile in their current workspace'),
  )
})

test.each([
  ['OpenRouter', 'openrouter'],
  ['Google', 'gemini'],
  ['xAI', 'xai'],
  ['DeepSeek', 'deepseek'],
  ['Z.ai', 'zai'],
])(
  'adding a %s key stores it on the gateway’s %s provider and binds it to the member virtual key',
  async (provider, gatewayProvider) => {
    expect(await postCredentialAs(bobInAcme, { provider, secret: `${secretValue}-${provider}` })).toEqual({
      status: 201,
      text: '',
    })
    const key = gatewayKeyOf(
      (await credentialRows()).find((row) => row.provider === provider) as { secret_ref: string },
    )
    expect(key.provider).toBe(gatewayProvider)
    expect((await gatewayKeysOf(gatewayProvider)).map(({ id }) => id)).toContain(key.id)
    expect(await boundKeyIdsOf(await virtualKeyIdOf(bob))).toContain(key.id)
  },
)

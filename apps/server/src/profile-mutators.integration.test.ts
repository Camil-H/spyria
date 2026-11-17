import { afterAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { memberId } from '@spyria/kernel'
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
  jobDone,
  jobStatesOf,
  lee,
  llmGatewayAt,
  openSharedTestApp,
  sessionTokenOf,
  succeeded,
  testAuthSettings,
  waitFor,
  waitingOnLock,
} from './testing/testing.ts'

setDefaultTimeout(30_000)

const { database, app, gateway, llmGateway, resultOf } = await openSharedTestApp()
const worker = startJobWorker(database, {
  pollIntervalMilliseconds: 5,
  retryDelayMilliseconds: 100,
  cleanupRetryDelayMilliseconds: 100,
  maximumCleanupRetryDelayMilliseconds: 400,
  llmGateway,
})
afterAll(() => worker.stop())
const tokenOf = (workspaceId: string, userId: string) => sessionTokenOf(database, workspaceId, userId)
const secretValue = 'sk-integration-secret-4321'

const postCredential = async (authorization: string, body: string, through = app) => {
  const response = await through.request('/api/llm-credentials', { method: 'POST', headers: { authorization }, body })
  return { status: response.status, text: await response.text() }
}
const postCredentialAs = async (member: typeof aliceInAcme, body: object, through = app) =>
  postCredential(`Bearer ${await tokenOf(member.workspaceId, member.userId)}`, JSON.stringify(body), through)

const newAcmeMember = async () => {
  const userId = memberId(`member-${crypto.randomUUID()}`)
  await database.$client`insert into users (id, email) values (${userId}, ${`${userId}@example.com`})`
  await database.$client`
    insert into memberships (workspace_id, user_id, role, display_name) values (${acme}, ${userId}, 'member', 'Dana')`
  return { workspaceId: acme, userId }
}
const credentialRows = async () => [...(await database.$client`select * from llm_credentials order by id`)]
const gatewayKeyOf = (row: { secret_ref: string } | undefined) => {
  const [, provider, id] = String(row?.secret_ref).match(/^gateway:([a-z]+)\/(.+)$/) ?? []
  return { provider: provider ?? '', id: id ?? '' }
}
const gatewayKeysOf = async (provider: string) =>
  (await gateway.call<{ keys: { id: string; name: string }[] }>(`/api/providers/${provider}/keys`)).keys
const virtualKeyIdOf = async (userId: string) =>
  (await database.$client`select virtual_key_id from member_gateway_keys where user_id = ${userId}`)[0]?.virtual_key_id
const gatewayVirtualKeyIds = async () =>
  ((await gateway.call<{ virtual_keys: { id: string }[] | null }>('/api/governance/virtual-keys')).virtual_keys ?? [])
    .map(({ id }) => id)
    .toSorted()
const boundKeyIdsOf = async (virtualKeyId: string) =>
  (
    (
      await gateway.call<{ virtual_key: { provider_configs: { keys: { key_id: string }[] }[] | null } }>(
        `/api/governance/virtual-keys/${virtualKeyId}`,
      )
    ).virtual_key.provider_configs ?? []
  )
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
  const rowsBefore = await credentialRows()
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
  expect(await credentialRows()).toEqual(rowsBefore)
  expect(await gatewayKeysOf('openai')).toEqual(keysBefore)
})

describe('a member’s LLM credentials', () => {
  test('adding a credential stores the secret in the gateway under an opaque name, binds it to the member virtual key, and Spyria keeps no secret and logs nothing', async () => {
    const consoleCalls = captureConsole()
    try {
      const response = await postCredentialAs(aliceInAcme, { provider: ' OpenAI ', secret: secretValue })
      expect(response).toEqual({ status: 201, text: '' })
      expect(consoleCalls.logged()).not.toContain(secretValue)
    } finally {
      consoleCalls.restore()
    }
    const rows = (await credentialRows()).filter((row) => row.user_id === alice)
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

  test('an unreachable gateway leaves no row and logs no secret', async () => {
    const dana = await newAcmeMember()
    const consoleCalls = captureConsole()
    try {
      expect(
        await postCredentialAs(
          dana,
          { provider: 'Mistral', secret: secretValue },
          appWithGateway('http://127.0.0.1:9'),
        ),
      ).toMatchObject({ status: 500 })
      expect(consoleCalls.logged()).not.toContain(secretValue)
    } finally {
      consoleCalls.restore()
    }
    expect((await credentialRows()).filter((row) => row.user_id === dana.userId)).toEqual([])
    expect(await virtualKeyIdOf(dana.userId)).toBeUndefined()
  })

  test('a failed Spyria commit deletes the gateway key it just created and logs no secret', async () => {
    const dana = await newAcmeMember()
    const rowsBefore = await credentialRows()
    const keysBefore = await gatewayKeysOf('mistral')
    await database.$client`alter table llm_credentials add constraint refuse_provider check (provider <> 'Mistral') not valid`
    const consoleCalls = captureConsole()
    try {
      expect(await postCredentialAs(dana, { provider: 'Mistral', secret: 'sk-refused-value' })).toMatchObject({
        status: 500,
      })
      expect(consoleCalls.logged()).not.toContain('sk-refused-value')
    } finally {
      consoleCalls.restore()
      await database.$client`alter table llm_credentials drop constraint refuse_provider`
    }
    expect(await credentialRows()).toEqual(rowsBefore)
    expect(await gatewayKeysOf('mistral')).toEqual(keysBefore)
    expect(await virtualKeyIdOf(dana.userId)).toBeUndefined()
  })

  test('a failed virtual key write removes the new row and its gateway key, and keeps the member key as it was', async () => {
    const rowsBefore = await credentialRows()
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
    expect(await credentialRows()).toEqual(rowsBefore)
    expect(await gatewayKeysOf('mistral')).toEqual(keysBefore)
    expect(await virtualKeyIdOf(alice)).toBe(virtualKeyId)
    expect(await boundKeyIdsOf(virtualKeyId)).toEqual(boundBefore)
  })

  test('a member cannot remove the credential of another member; removing one unbinds and deletes its gateway key, removing the last keeps the virtual key with no provider for tools', async () => {
    const dana = await newAcmeMember()
    for (const provider of ['OpenAI', 'Mistral'])
      expect(await postCredentialAs(dana, { provider, secret: `${secretValue}-${provider}` })).toEqual({
        status: 201,
        text: '',
      })
    const rowsBefore = await credentialRows()
    const [openAi] = rowsBefore.filter((row) => row.user_id === dana.userId && row.provider === 'OpenAI')
    const [mistral] = rowsBefore.filter((row) => row.user_id === dana.userId && row.provider === 'Mistral')
    const removal = { workspaceId: acme, credentialId: openAi?.id, memberId: dana.userId }
    expect(await resultOf(bobInAcme, 'profile.removeLlmCredential', removal)).toEqual(
      failedWith(`LLM credential ${openAi?.id} was not found`),
    )
    expect(await credentialRows()).toEqual(rowsBefore)

    const virtualKeyId = await virtualKeyIdOf(dana.userId)
    const openAiKey = gatewayKeyOf(openAi as { secret_ref: string })
    const mistralKey = gatewayKeyOf(mistral as { secret_ref: string })
    expect(await resultOf(dana, 'profile.removeLlmCredential', removal)).toEqual(succeeded)
    expect(await credentialRows()).toEqual(rowsBefore.filter((row) => row.id !== openAi?.id))
    await jobDone('profile.gateway-sync', { memberId: dana.userId })
    expect((await gateway.request(`/api/providers/openai/keys/${openAiKey.id}`)).status).toBe(404)
    expect(await boundKeyIdsOf(virtualKeyId)).toEqual([mistralKey.id])

    expect(
      await resultOf(dana, 'profile.removeLlmCredential', { workspaceId: acme, credentialId: mistral?.id }),
    ).toEqual(succeeded)
    await jobDone('profile.gateway-sync', { memberId: dana.userId })
    expect(await boundKeyIdsOf(virtualKeyId)).toEqual([])
    expect((await gateway.request(`/api/providers/mistral/keys/${mistralKey.id}`)).status).toBe(404)
    expect(await virtualKeyIdOf(dana.userId)).toBe(virtualKeyId)
    expect(await jobStatesOf('profile.gateway-sync', { memberId: dana.userId })).toEqual(['done', 'done'])
  })
})

test('renameMember changes the display name of the member in the current workspace only', async () => {
  const displayNames = async () =>
    (await database.query.memberships.findMany({ orderBy: { workspaceId: 'asc', userId: 'asc' } })).map(
      ({ workspaceId, userId, displayName }) => ({ workspaceId, userId, displayName }),
    )
  const namesBefore = await displayNames()
  expect(namesBefore).toEqual(
    expect.arrayContaining([
      { workspaceId: acme, userId: alice, displayName: 'Alice' },
      { workspaceId: acme, userId: bob, displayName: 'Bob' },
      { workspaceId: acme, userId: lee, displayName: 'Lee' },
      { workspaceId: globex, userId: alice, displayName: 'Alice' },
    ]),
  )
  expect(
    await resultOf(aliceInAcme, 'profile.renameMember', { workspaceId: acme, name: ' Alice D. ', memberId: bob }),
  ).toEqual(succeeded)
  expect(await displayNames()).toEqual(
    namesBefore.map((row) =>
      row.workspaceId === acme && row.userId === alice ? { ...row, displayName: 'Alice D.' } : row,
    ),
  )
  expect(await resultOf(aliceInAcme, 'profile.renameMember', { workspaceId: globex, name: 'Other' })).toEqual(
    failedWith('A member can only change their own profile in their current workspace'),
  )
})

test('changeAvatar stores a picture of the member in the current workspace only, refuses anything but a small image, and removes it', async () => {
  const picture = `data:image/png;base64,${Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...Array(24).fill(0)]).toString('base64')}`
  const avatarOf = async (workspaceId: string, userId: string) =>
    (await database.query.memberships.findFirst({ where: { workspaceId, userId } }))?.avatar
  expect(await resultOf(aliceInAcme, 'profile.changeAvatar', { workspaceId: acme, avatar: picture })).toEqual(succeeded)
  expect(await avatarOf(acme, alice)).toBe(picture)
  expect(await avatarOf(globex, alice)).toBeNull()
  expect(
    await resultOf(aliceInAcme, 'profile.changeAvatar', {
      workspaceId: acme,
      avatar: `data:image/svg+xml;base64,${btoa('<svg xmlns="http://www.w3.org/2000/svg"/>')}`,
    }),
  ).toEqual(failedWith('A profile picture must be a small PNG, JPEG or WebP image'))
  expect(await resultOf(aliceInAcme, 'profile.changeAvatar', { workspaceId: globex, avatar: null })).toEqual(
    failedWith('A member can only change their own profile in their current workspace'),
  )
  expect(await avatarOf(acme, alice)).toBe(picture)
  expect(await resultOf(aliceInAcme, 'profile.changeAvatar', { workspaceId: acme, avatar: null })).toEqual(succeeded)
  expect(await avatarOf(acme, alice)).toBeNull()
})

test.each([
  ['OpenRouter', 'openrouter'],
  ['Google', 'gemini'],
  ['xAI', 'xai'],
  ['DeepSeek', 'deepseek'],
  ['Z.ai', 'zai'],
  ['Meta', 'meta'],
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

const postCredentialDuringRemoval = async (
  member: typeof aliceInAcme,
  body: object,
  beforeRemovalCommits = async () => {},
) => {
  const authorization = `Bearer ${await tokenOf(member.workspaceId, member.userId)}`
  let posted: ReturnType<typeof postCredential> | undefined
  await database.$client.begin(async (removal) => {
    await removal`
      update memberships set removed_at = now() where workspace_id = ${acme} and user_id = ${member.userId}`
    posted = postCredential(authorization, JSON.stringify(body))
    await waitFor(() => waitingOnLock(database))
    await beforeRemovalCommits()
  })
  return posted
}
const memberRemoved = (removedMemberId: string) => ({
  status: 400,
  text: JSON.stringify({ error: 'member_not_found', message: `${removedMemberId} is not a member of this workspace` }),
})

test('a credential added while its member is being removed is refused once the removal commits, and leaves no row, member key nor gateway key behind', async () => {
  const dana = await newAcmeMember()
  const keysBefore = await gatewayKeysOf('mistral')

  expect(await postCredentialDuringRemoval(dana, { provider: 'Mistral', secret: secretValue })).toEqual(
    memberRemoved(dana.userId),
  )
  expect((await credentialRows()).filter((row) => row.user_id === dana.userId)).toEqual([])
  expect(await virtualKeyIdOf(dana.userId)).toBeUndefined()
  expect(await gatewayKeysOf('mistral')).toEqual(keysBefore)
})

test('a credential refused because its member was removed leaves no virtual key behind, even after the removal already deleted theirs', async () => {
  const dana = await newAcmeMember()
  expect(await postCredentialAs(dana, { provider: 'OpenAI', secret: secretValue })).toEqual({ status: 201, text: '' })
  const virtualKeyId = await virtualKeyIdOf(dana.userId)
  const virtualKeysBefore = await gatewayVirtualKeyIds()

  expect(
    await postCredentialDuringRemoval(dana, { provider: 'Mistral', secret: secretValue }, async () => {
      await gateway.call(`/api/governance/virtual-keys/${virtualKeyId}`, { method: 'DELETE' })
    }),
  ).toEqual(memberRemoved(dana.userId))
  expect(await gatewayVirtualKeyIds()).toEqual(virtualKeysBefore.filter((id) => id !== virtualKeyId))
})

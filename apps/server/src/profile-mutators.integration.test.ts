import { afterAll, expect, spyOn, test } from 'bun:test'
import { createTestDatabase, startZeroCache } from '@hq/db/testing'
import { schema } from '@hq/db/zero'
import { queries } from '@hq/db/zero-queries'
import { memberId, workspaceId } from '@hq/kernel'
import { zeroDrizzle } from '@rocicorp/zero/server/adapters/drizzle'
import { createApp } from './app.ts'
import { createSessionTokens } from './session-tokens.ts'

const testDatabase = await createTestDatabase()
const { database } = testDatabase
const tokenSecret = 'profile-test-secret'
const app = createApp({ database, tokenSecret, isDevAuthEnabled: true })
const server = Bun.serve({ port: 0, fetch: app.fetch })
const appId = 'hqprofiletest'
const zeroCache = await startZeroCache({
  databaseName: testDatabase.name,
  port: 4898,
  appId,
  serverUrl: server.url.origin,
}).catch(async (error) => {
  await server.stop(true)
  await testDatabase.drop()
  throw error
})
afterAll(async () => {
  await zeroCache.stop()
  await server.stop(true)
  await testDatabase.drop()
})

const acme = 'workspace-acme'
const globex = 'workspace-globex'
const alice = 'member-alice'
const bob = 'member-bob'
const aliceInAcme = { workspaceId: acme, userId: alice }
const bobInAcme = { workspaceId: acme, userId: bob }
const succeeded = {}
const failedWith = (message: string) => ({ error: 'app', message })
const secretValue = 'sk-integration-secret-4321'

const tokenOf = async (workspaceId: string, userId: string) => {
  const response = await app.request('/auth/dev-token', {
    method: 'POST',
    body: JSON.stringify({ workspaceId, userId }),
  })
  return ((await response.json()) as { token: string }).token
}

const resultOf = async (
  { workspaceId, userId }: { workspaceId: string; userId: string },
  name: string,
  args: Record<string, unknown>,
) => {
  const response = await app.request(`/api/mutate?schema=${appId}_0&appID=${appId}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${await tokenOf(workspaceId, userId)}` },
    body: JSON.stringify({
      clientGroupID: crypto.randomUUID(),
      mutations: [{ type: 'custom', id: 1, clientID: crypto.randomUUID(), name, args: [args], timestamp: Date.now() }],
      pushVersion: 1,
      timestamp: Date.now(),
      requestID: crypto.randomUUID(),
    }),
  })
  return ((await response.json()) as { mutations: { result: unknown }[] }).mutations[0]?.result
}

const postCredential = async (authorization: string | undefined, body: string) => {
  const response = await app.request('/api/llm-credentials', {
    method: 'POST',
    headers: authorization === undefined ? {} : { authorization },
    body,
  })
  return { status: response.status, text: await response.text() }
}
const postCredentialAs = async (member: typeof aliceInAcme, body: object) =>
  postCredential(`Bearer ${await tokenOf(member.workspaceId, member.userId)}`, JSON.stringify(body))

const credentialRows = () => database.$client`select * from llm_credentials order by id`
const vaultRows = async () => [...(await database.$client`select * from placeholder_secrets`)]
const connectionsOf = (userId: string) =>
  database.query.toolConnections.findMany({ where: { workspaceId: acme, userId }, orderBy: { position: 'asc' } })
const consoleSpies = () => (['log', 'info', 'warn', 'error', 'debug'] as const).map((method) => spyOn(console, method))
const loggedText = (spies: ReturnType<typeof consoleSpies>) =>
  spies.map((spy) => Bun.inspect(spy.mock.calls)).join('\n')
const restore = (spies: ReturnType<typeof consoleSpies>) => {
  for (const spy of spies) spy.mockRestore()
}

const zeroDatabase = zeroDrizzle(schema, database)
const visibleWorkspaceConnections = (workspace: string, user: string) =>
  zeroDatabase.transaction((tx) =>
    tx.run(
      queries.workspaceConnections.fn({
        args: undefined,
        ctx: { workspaceId: workspaceId(workspace), userId: memberId(user), role: 'member' },
      }),
    ),
  )

test('the credential endpoint refuses a missing, invalid or non-member token', async () => {
  const body = JSON.stringify({ provider: 'OpenAI', secret: secretValue })
  const nonMemberToken = await createSessionTokens(tokenSecret, async () => 'member').issue({
    userId: memberId(bob),
    workspaceId: workspaceId(globex),
    role: 'member',
  })
  expect((await postCredential(undefined, body)).status).toBe(401)
  expect((await postCredential('Bearer not-a-token', body)).status).toBe(401)
  expect((await postCredential(`Bearer ${nonMemberToken}`, body)).status).toBe(403)
  expect(await credentialRows()).toHaveLength(1)
})

test('the credential endpoint refuses blank, missing or malformed fields and stores nothing', async () => {
  const token = `Bearer ${await tokenOf(acme, alice)}`
  for (const body of [
    { provider: '  ', secret: secretValue },
    { provider: 'OpenAI', secret: '  ' },
    { provider: 'OpenAI' },
    { secret: secretValue },
    { provider: 42, secret: secretValue },
  ])
    expect((await postCredential(token, JSON.stringify(body))).status).toBe(400)
  expect(await postCredential(token, 'not json')).toMatchObject({ status: 400 })
  expect(await credentialRows()).toHaveLength(1)
  expect(await vaultRows()).toEqual([])
})

test('adding a credential stores the secret in the vault and the row with last4, returning no secret and logging nothing', async () => {
  const spies = consoleSpies()
  try {
    const response = await postCredentialAs(aliceInAcme, { provider: ' OpenAI ', secret: secretValue })
    expect(response).toEqual({ status: 201, text: '' })
    expect(loggedText(spies)).not.toContain(secretValue)
  } finally {
    restore(spies)
  }
  const stored = (await credentialRows()).find((row) => row.provider === 'OpenAI')
  expect(stored).toMatchObject({ workspace_id: acme, user_id: alice, last4: '4321' })
  expect(await vaultRows()).toEqual([{ workspace_id: acme, ref: stored?.secret_ref, value: secretValue }])
})

test('the secret never reaches a replicated table or column', async () => {
  const publishedTables = await database.$client<{ table: string; columns: string[] }[]>`
    select tablename as table, attnames as columns from pg_publication_tables where pubname = 'hq_zero'`
  expect(publishedTables.map(({ table }) => table)).not.toContain('placeholder_secrets')
  expect(publishedTables.find(({ table }) => table === 'llm_credentials')?.columns).not.toContain('secret_ref')
  for (const { table, columns } of publishedTables) {
    const rows = await database.$client.unsafe(
      `select ${columns.map((column) => `"${column}"`).join(', ')} from "${table}"`,
    )
    expect({ table, leaks: JSON.stringify(rows).includes(secretValue) }).toEqual({ table, leaks: false })
  }
})

test('a failed credential write rolls back the vault and logs no secret', async () => {
  await database.$client`alter table llm_credentials add constraint refuse_provider check (provider <> 'Refused') not valid`
  await database.$client`alter table placeholder_secrets add constraint refuse_value check (value <> 'sk-refused-value') not valid`
  const spies = consoleSpies()
  try {
    expect(await postCredentialAs(aliceInAcme, { provider: 'Refused', secret: secretValue })).toMatchObject({
      status: 500,
    })
    expect(await postCredentialAs(aliceInAcme, { provider: 'Mistral', secret: 'sk-refused-value' })).toMatchObject({
      status: 500,
    })
    expect(loggedText(spies)).not.toContain(secretValue)
    expect(loggedText(spies)).not.toContain('sk-refused-value')
  } finally {
    restore(spies)
    await database.$client`alter table llm_credentials drop constraint refuse_provider`
    await database.$client`alter table placeholder_secrets drop constraint refuse_value`
  }
  expect((await credentialRows()).map((row) => row.provider)).not.toContain('Refused')
  expect(await vaultRows()).toHaveLength(1)
})

test('a member cannot remove the credential of another member; the owner removes it and its secret', async () => {
  const [stored] = (await credentialRows()).filter((row) => row.provider === 'OpenAI')
  const removal = { workspaceId: acme, credentialId: stored?.id, memberId: alice }
  expect(await resultOf(bobInAcme, 'profile.removeLlmCredential', removal)).toEqual(
    failedWith(`LLM credential ${stored?.id} was not found`),
  )
  expect(await credentialRows()).toHaveLength(2)
  expect(await resultOf(aliceInAcme, 'profile.removeLlmCredential', removal)).toEqual(succeeded)
  expect((await credentialRows()).map((row) => row.provider)).toEqual(['Anthropic'])
  expect(await vaultRows()).toEqual([])
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

test('Alice sees the connections of Bob only through a chat Bob owns in a workspace they share, never Globex rows', async () => {
  await database.$client`
    insert into workspace_connections (workspace_id, user_id, tool, access, position)
    values (${globex}, ${alice}, 'Globex warehouse', 'All tables', 1)`
  const accessOf = async (workspace: string, user: string) =>
    (await visibleWorkspaceConnections(workspace, user)).map((row) => `${row.workspaceId} ${row.userId} ${row.access}`)
  expect(await accessOf(acme, alice)).toEqual([
    `${acme} ${alice} 2 of 5 tables`,
    `${acme} ${alice} All sources`,
    `${acme} ${bob} 1 of 5 tables`,
  ])
  expect(await accessOf(acme, bob)).toEqual([
    `${acme} ${alice} 2 of 5 tables`,
    `${acme} ${alice} All sources`,
    `${acme} ${bob} 1 of 5 tables`,
  ])
  expect(await accessOf(globex, alice)).toEqual([`${globex} ${alice} All tables`])
  await database.$client`update chats set owner_user_id = ${alice} where owner_user_id = ${bob}`
  expect(await accessOf(acme, alice)).toEqual([`${acme} ${alice} 2 of 5 tables`, `${acme} ${alice} All sources`])
  expect(await accessOf(acme, bob)).toEqual([
    `${acme} ${alice} 2 of 5 tables`,
    `${acme} ${alice} All sources`,
    `${acme} ${bob} 1 of 5 tables`,
  ])
})

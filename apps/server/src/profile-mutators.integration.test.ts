import { expect, spyOn, test } from 'bun:test'
import {
  acme,
  alice,
  aliceInAcme,
  failedWith,
  globex,
  openSharedTestApp,
  bob,
  bobInAcme,
  sessionTokenOf,
  succeeded,
} from './testing.ts'

const { database, app, resultOf } = await openSharedTestApp()
const tokenOf = (workspaceId: string, userId: string) => sessionTokenOf(database, workspaceId, userId)
const secretValue = 'sk-integration-secret-4321'

const postCredential = async (authorization: string, body: string) => {
  const response = await app.request('/api/llm-credentials', { method: 'POST', headers: { authorization }, body })
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

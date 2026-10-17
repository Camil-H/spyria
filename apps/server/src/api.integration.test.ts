import { afterAll, expect, test } from 'bun:test'
import { llmCredentials } from '@hq/db/postgres'
import { createTestDatabase, databaseDropTimeoutMilliseconds } from '@hq/db/testing'
import { schema } from '@hq/db/zero'
import { queries } from '@hq/db/zero-queries'
import { llmCredentialsPath } from '@hq/profile/server'
import type { AST } from '@rocicorp/zero'
import type { ServerSchema } from '@rocicorp/zero/server'
import { executePostgresQuery } from '@rocicorp/zero/server'
import { zeroDrizzle } from '@rocicorp/zero/server/adapters/drizzle'
import { createApp } from './app.ts'
import { issueSessionToken } from './auth/session-tokens.ts'
import { openSessions } from './auth/sessions.ts'
import { acme, alice, globex, lee, bob, sessionTokenOf, testAuthSettings } from './testing/testing.ts'

const testDatabase = await createTestDatabase()
const otherDatabase = await createTestDatabase()
afterAll(async () => {
  await testDatabase.drop()
  await otherDatabase.drop()
}, databaseDropTimeoutMilliseconds)

const app = createApp({ database: testDatabase.database, ...testAuthSettings })
const memberPrivateTables = ['read_markers', 'thread_read_markers', 'llm_credentials']
const chatOwnerConnectionTables = ['workspace_connections', 'tool_connections']
type ReplicatedTable = {
  name: string
  serverName?: string
  primaryKey: readonly string[]
  columns: Record<string, { type: string; optional?: boolean; serverName?: string }>
}
const replicatedTables: ReplicatedTable[] = Object.values(schema.tables)
const serverNameOf = (name: string, column: { serverName?: string }) => column.serverName ?? name

const serverNamedSchema = {
  ...schema,
  tables: Object.fromEntries(
    replicatedTables.map((table) => [
      serverNameOf(table.name, table),
      {
        name: serverNameOf(table.name, table),
        primaryKey: table.primaryKey.map((column) => serverNameOf(column, table.columns[column] ?? {})),
        columns: Object.fromEntries(
          Object.entries(table.columns).map(([name, column]) => [
            serverNameOf(name, column),
            { type: column.type, optional: column.optional },
          ]),
        ),
      },
    ]),
  ),
}

const serverSchema: ServerSchema = {}
for (const column of await testDatabase.database.$client<{ table: string; column: string; type: string }[]>`
  select table_name as table, column_name as column, data_type as type
  from information_schema.columns where table_schema = 'public'`)
  serverSchema[column.table] = {
    ...serverSchema[column.table],
    [column.column]: { type: column.type, isEnum: false, isArray: false },
  }

const dbProvider = zeroDrizzle(schema, testDatabase.database)
const rowsOf = (ast: AST) =>
  dbProvider.transaction(
    (transaction) =>
      executePostgresQuery(
        transaction.dbTransaction,
        ast,
        { singular: false, relationships: {} },
        serverNamedSchema as unknown as typeof schema,
        serverSchema,
      ) as Promise<Record<string, unknown>[]>,
  )

const tokenOf = (workspace: string, user: string) => sessionTokenOf(testDatabase.database, workspace, user)

const transform = async (token: string, args: unknown[] = []) => {
  const response = await app.request('/api/query', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify(['transform', replicatedTables.map(({ name }) => ({ id: name, name, args }))]),
  })
  const body = (await response.json()) as { queries: { name: string; ast: AST }[] }
  return { status: response.status, astByTable: new Map(body.queries.map(({ name, ast }) => [name, ast])) }
}

const readAll = async (workspace: string, user: string) => {
  const { astByTable } = await transform(await tokenOf(workspace, user))
  return new Map(
    await Promise.all(
      replicatedTables.map(
        async (table) => [serverNameOf(table.name, table), await rowsOf(astByTable.get(table.name) as AST)] as const,
      ),
    ),
  )
}

const expectedCount = async (table: string, workspace: string, user: string) => {
  const readableChats = `select id from chats where workspace_id = '${workspace}' and (visibility = 'public'
    or id in (select chat_id from chat_participants where workspace_id = '${workspace}' and user_id = '${user}'))`
  const userCondition = memberPrivateTables.includes(table) ? `and user_id = '${user}'` : ''
  const chatCondition =
    table === 'chats'
      ? `and id in (${readableChats})`
      : serverSchema[table]?.chat_id
        ? `and chat_id in (${readableChats})`
        : chatOwnerConnectionTables.includes(table)
          ? `and (user_id = '${user}' or user_id in (select owner_user_id from chats where id in (${readableChats})))`
          : ''
  const [{ count }] = await testDatabase.database.$client.unsafe<[{ count: number }]>(
    `select count(*)::int as count from "${table}" where workspace_id = '${workspace}' ${userCondition} ${chatCondition}`,
  )
  return count
}

const readers = [
  { name: 'Alice in Acme', workspace: acme, user: alice },
  { name: 'Alice in Globex', workspace: globex, user: alice },
  { name: 'Bob in Acme', workspace: acme, user: bob },
  { name: 'Lee in Acme', workspace: acme, user: lee },
]
await testDatabase.database.$client`
  insert into thread_read_markers (workspace_id, user_id, chat_id, thread_root_id, last_read_seq)
  select ${acme}, reader.user_id, message.chat_id, message.id, 1
  from messages message cross join (values (${alice}), (${bob}), (${lee})) as reader (user_id)
  where message.workspace_id = ${acme} and message.id in ('message-welcome-1', 'message-invoice-1')`
const rowsByReader = new Map(
  await Promise.all(
    readers.map(async (reader) => [reader.name, await readAll(reader.workspace, reader.user)] as const),
  ),
)
const tenantTables = replicatedTables
  .map((table) => serverNameOf(table.name, table))
  .filter((table) => table !== 'users' && table !== 'workspaces')

test('there is one synced query per replicated table', () => {
  expect(
    Object.keys(queries)
      .filter((key) => key !== '~')
      .sort(),
  ).toEqual(replicatedTables.map(({ name }) => name).sort())
})

test.each(readers.flatMap((reader) => tenantTables.map((table) => [reader.name, table, reader] as const)))(
  '%s reads only the rows of %s it may read in its own workspace',
  async (_, table, reader) => {
    const rows = rowsByReader.get(reader.name)?.get(table) ?? []
    expect(rows.filter((row) => row.workspace_id !== reader.workspace)).toEqual([])
    expect(rows.length).toBe(await expectedCount(table, reader.workspace, reader.user))
  },
)

test('a member reads the public channels and the private chats they take part in', () => {
  const chatIdsOf = (reader: string) =>
    rowsByReader
      .get(reader)
      ?.get('chats')
      ?.map((row) => row.id)
  expect(chatIdsOf('Alice in Acme')).toEqual([
    'chat-welcome',
    'chat-setup-helper',
    'chat-invoice-bug',
    'chat-standup',
    'chat-research',
  ])
  expect(chatIdsOf('Bob in Acme')).toEqual(['chat-welcome', 'chat-setup-helper', 'chat-invoice-bug', 'chat-standup'])
  expect(chatIdsOf('Lee in Acme')).toEqual(['chat-welcome', 'chat-invoice-bug', 'chat-standup'])
})

test('the member-private rows of Bob are not visible to Alice', () => {
  for (const table of memberPrivateTables) {
    expect(
      rowsByReader
        .get('Alice in Acme')
        ?.get(table)
        ?.filter((row) => row.user_id !== alice),
    ).toEqual([])
    expect(
      rowsByReader
        .get('Bob in Acme')
        ?.get(table)
        ?.filter((row) => row.user_id !== bob),
    ).toEqual([])
  }
})

test('connections are visible to the members of the workspace of a chat their owner owns', () => {
  const accessOf = (reader: string) =>
    rowsByReader
      .get(reader)
      ?.get('workspace_connections')
      ?.map((row) => `${row.user_id}: ${row.access}`)
  const acmeConnections = [`${alice}: 2 of 5 tables`, `${alice}: All sources`, `${bob}: 1 of 5 tables`]
  expect(accessOf('Bob in Acme')).toEqual(acmeConnections)
  expect(accessOf('Alice in Acme')).toEqual(acmeConnections)
  expect(accessOf('Alice in Globex')).toEqual([])
})

test('workspaces lists every workspace of the member and users lists the members of the current workspace', () => {
  const idsOf = (reader: string, table: string, column: string) =>
    rowsByReader
      .get(reader)
      ?.get(table)
      ?.map((row) => row[column])
  expect(idsOf('Alice in Acme', 'workspaces', 'workspace_id')).toEqual([acme, globex])
  expect(idsOf('Alice in Globex', 'workspaces', 'workspace_id')).toEqual([acme, globex])
  expect(idsOf('Bob in Acme', 'workspaces', 'workspace_id')).toEqual([acme])
  expect(idsOf('Alice in Acme', 'users', 'id')).toEqual([alice, lee, bob])
  expect(idsOf('Alice in Globex', 'users', 'id')).toEqual([alice])
})

test('a Globex connection stays in Globex and an ownership change hides the connections of Bob from Alice', async () => {
  await testDatabase.database.$client`
    insert into workspace_connections (workspace_id, user_id, tool, access, position)
    values (${globex}, ${alice}, 'Globex warehouse', 'All tables', 1)`
  const accessOf = async (workspace: string, user: string) =>
    ((await readAll(workspace, user)).get('workspace_connections') ?? []).map(
      (row) => `${row.workspace_id} ${row.user_id} ${row.access}`,
    )
  expect(await accessOf(globex, alice)).toEqual([`${globex} ${alice} All tables`])
  await testDatabase.database.$client`update chats set owner_user_id = ${alice} where owner_user_id = ${bob}`
  expect(await accessOf(acme, alice)).toEqual([`${acme} ${alice} 2 of 5 tables`, `${acme} ${alice} All sources`])
  expect(await accessOf(acme, bob)).toEqual([
    `${acme} ${alice} 2 of 5 tables`,
    `${acme} ${alice} All sources`,
    `${acme} ${bob} 1 of 5 tables`,
  ])
})

test('the connections keep their position order', () => {
  expect(
    rowsByReader
      .get('Alice in Acme')
      ?.get('tool_connections')
      ?.map((row) => row.tool),
  ).toEqual(['GitHub', 'Slack', 'Notion'])
})

test('crafted query arguments cannot reach another workspace or member', async () => {
  const token = await tokenOf(acme, alice)
  const plain = await transform(token)
  const crafted = await transform(token, [{ workspaceId: globex, userId: bob }])
  expect(crafted.status).toBe(200)
  expect(crafted.astByTable).toEqual(plain.astByTable)
  expect(JSON.stringify([...crafted.astByTable.values()])).not.toContain(globex)
})

test('a sign-in opens no session in a workspace without membership', async () => {
  expect(await openSessions(testDatabase.database, bob, globex)).toHaveLength(0)
})

test.each(['/api/query', '/api/mutate', llmCredentialsPath])(
  '%s refuses with 403 a valid token without membership and writes nothing',
  async (path) => {
    const { token } = await issueSessionToken(testAuthSettings.tokenSecret, {
      userId: bob,
      workspaceId: globex,
      role: 'member',
      sessionId: 'no-session',
    })
    const credentialCount = await testDatabase.database.$count(llmCredentials)
    const response = await app.request(path, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify(['transform', []]),
    })
    expect(response.status).toBe(403)
    expect(await testDatabase.database.$count(llmCredentials)).toBe(credentialCount)
  },
)

test('with test hooks, the database claim of a token selects the database the server reads', async () => {
  await otherDatabase.database.$client`insert into users (id, email) values ('member-dana', 'dana@example.com')`
  await otherDatabase.database.$client`
    insert into memberships (workspace_id, user_id, role, display_name)
    values (${acme}, 'member-dana', 'member', 'Dana')`
  const multiDatabaseApp = createApp({
    database: testDatabase.database,
    ...testAuthSettings,
    testDatabaseByName: () => otherDatabase.database,
  })
  expect(await openSessions(testDatabase.database, 'member-dana', acme)).toHaveLength(0)
  const [danaSession] = await openSessions(otherDatabase.database, 'member-dana', acme)
  if (!danaSession) throw new Error('Dana has no session')
  expect(danaSession.role).toBe('member')
  const issued = await issueSessionToken(testAuthSettings.tokenSecret, danaSession, {
    databaseName: otherDatabase.name,
  })
  const queryWith = (server: typeof app) =>
    server.request('/api/query', {
      method: 'POST',
      headers: { authorization: `Bearer ${issued.token}` },
      body: JSON.stringify(['transform', []]),
    })
  expect((await queryWith(multiDatabaseApp)).status).toBe(200)
  expect((await queryWith(app)).status).toBe(403)
})

test('the routing read tells a member whether a workspace host of their workspace is online, without host details', async () => {
  const hqRuntimeAvailableFor = async (user: string) =>
    (
      (await (
        await app.request('/api/chats/chat-invoice-bug/routing', {
          headers: { authorization: `Bearer ${await tokenOf(acme, user)}` },
        })
      ).json()) as { hqRuntimeAvailable: boolean }
    ).hqRuntimeAvailable
  const addHost = (workspace: string, id: string, status: string, ownerId: string | null) =>
    testDatabase.database.$client`
      insert into runtime_hosts (workspace_id, id, name, status, running_runtimes, created_by, owner_id, created_at)
      values (${workspace}, ${id}, ${id}, ${status}, 0, ${alice}, ${ownerId}, now())`
  await addHost(acme, 'host-acme-offline', 'offline', null)
  await addHost(acme, 'host-bob-machine', 'online', bob)
  await addHost(globex, 'host-globex-online', 'online', null)
  expect(await hqRuntimeAvailableFor(bob)).toBe(false)
  await testDatabase.database.$client`update runtime_hosts set status = 'online' where id = 'host-acme-offline'`
  expect(await hqRuntimeAvailableFor(bob)).toBe(true)
  expect(await hqRuntimeAvailableFor(alice)).toBe(true)
  await testDatabase.database.$client`
    delete from runtime_hosts where id in ('host-acme-offline', 'host-bob-machine', 'host-globex-online')`
})

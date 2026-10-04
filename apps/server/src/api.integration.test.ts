import { afterAll, expect, test } from 'bun:test'
import { createTestDatabase } from '@hq/db/testing'
import { schema } from '@hq/db/zero'
import { queries } from '@hq/db/zero-queries'
import type { AST } from '@rocicorp/zero'
import type { ServerSchema } from '@rocicorp/zero/server'
import { executePostgresQuery } from '@rocicorp/zero/server'
import { zeroDrizzle } from '@rocicorp/zero/server/adapters/drizzle'
import { createApp } from './app.ts'
import { issueSessionToken } from './auth/session-tokens.ts'
import { openSessions } from './auth/sessions.ts'
import { sessionTokenOf, testAuthSettings } from './testing.ts'

const testDatabase = await createTestDatabase()
afterAll(() => testDatabase.drop())

const app = createApp({ database: testDatabase.database, ...testAuthSettings })
const acme = 'workspace-acme'
const globex = 'workspace-globex'
const alice = 'member-alice'
const bob = 'member-bob'
const memberPrivateTables = ['read_markers', 'llm_credentials']
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
  const userCondition = memberPrivateTables.includes(table)
    ? `and user_id = '${user}'`
    : chatOwnerConnectionTables.includes(table)
      ? `and (user_id = '${user}' or user_id in (select owner_user_id from chats where workspace_id = '${workspace}'))`
      : ''
  const [{ count }] = await testDatabase.database.$client.unsafe<[{ count: number }]>(
    `select count(*)::int as count from "${table}" where workspace_id = '${workspace}' ${userCondition}`,
  )
  return count
}

const readers = [
  { name: 'Alice in Acme', workspace: acme, user: alice },
  { name: 'Alice in Globex', workspace: globex, user: alice },
  { name: 'Bob in Acme', workspace: acme, user: bob },
]
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
  '%s reads only its own workspace rows of %s',
  async (_, table, reader) => {
    const rows = rowsByReader.get(reader.name)?.get(table) ?? []
    expect(rows.filter((row) => row.workspace_id !== reader.workspace)).toEqual([])
    expect(rows.length).toBe(await expectedCount(table, reader.workspace, reader.user))
  },
)

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
  expect(idsOf('Alice in Acme', 'users', 'id')).toEqual([alice, bob])
  expect(idsOf('Alice in Globex', 'users', 'id')).toEqual([alice])
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

test.each(['/api/query', '/api/mutate'])('%s refuses with 403 a valid token without membership', async (path) => {
  const { token } = await issueSessionToken(testAuthSettings.tokenSecret, {
    userId: bob,
    workspaceId: globex,
    role: 'member',
    sessionId: 'no-session',
  })
  const response = await app.request(path, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify(['transform', []]),
  })
  expect(response.status).toBe(403)
})

test('with test hooks, the database claim of a token selects the database the server reads', async () => {
  const otherDatabase = await createTestDatabase()
  try {
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
  } finally {
    await otherDatabase.drop()
  }
})

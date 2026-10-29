import { afterAll, expect, test } from 'bun:test'
import type { AST } from '@rocicorp/zero'
import type { ServerSchema } from '@rocicorp/zero/server'
import { executePostgresQuery } from '@rocicorp/zero/server'
import { zeroDrizzle } from '@rocicorp/zero/server/adapters/drizzle'
import { llmCredentials } from '@spyria/db/postgres'
import { createTestDatabase, databaseDropTimeoutMilliseconds } from '@spyria/db/testing'
import { schema } from '@spyria/db/zero'
import { queries } from '@spyria/db/zero-queries'
import { llmCredentialsPath } from '@spyria/profile/server'
import { createApp } from './app.ts'
import { issueSessionToken } from './auth/session-tokens.ts'
import { openSessions } from './auth/sessions.ts'
import { acme, alice, bob, globex, lee, sessionTokenOf, testAuthSettings } from './testing/testing.ts'

const testDatabase = await createTestDatabase()
const otherDatabase = await createTestDatabase()
afterAll(async () => {
  await testDatabase.drop()
  await otherDatabase.drop()
}, databaseDropTimeoutMilliseconds)

const app = createApp({ database: testDatabase.database, ...testAuthSettings })
const memberPrivateTables = ['read_markers', 'thread_read_markers', 'llm_credentials']
const chatOwnerConnectionTables = ['tool_connections', 'connection_restrictions']
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
const listed = { singular: false, relationships: {} }
const windowFormat = { singular: false, relationships: { replies: listed, threadReplies: listed } }
type Row = Record<string, unknown>
const rowsOf = async (ast: AST) => {
  const rows = (await dbProvider.transaction(
    (transaction) =>
      executePostgresQuery(
        transaction.dbTransaction,
        ast,
        ast.related?.length ? windowFormat : listed,
        serverNamedSchema as unknown as typeof schema,
        serverSchema,
      ) as Promise<Row[]>,
  )) as Row[]
  const flattened = rows.flatMap(({ replies, threadReplies, ...row }) => [
    row,
    ...((replies as Row[] | undefined) ?? []),
    ...((threadReplies as Row[] | undefined) ?? []),
  ])
  return [...new Map(flattened.map((row) => [JSON.stringify([row.id ?? row, row.chat_id]), row])).values()]
}

const tokenOf = (workspace: string, user: string) => sessionTokenOf(testDatabase.database, workspace, user)

const perChatReads: Record<string, (chatId: string) => readonly [string, object]> = {
  messages: (chatId) => ['chatMessages', { chatId, limit: 1000 }],
  usageEntries: (chatId) => ['chatUsage', { chatId }],
  browserPages: (chatId) => ['chatBrowserPages', { chatId }],
}
const allChatIds = (await testDatabase.database.$client<{ id: string }[]>`select id from chats`).map(({ id }) => id)

const transformOf = async (token: string, requests: readonly { id: string; name: string; args: unknown[] }[]) => {
  const response = await app.request('/api/query', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify(['transform', requests]),
  })
  const body = (await response.json()) as { queries: { id: string; ast: AST }[] }
  return { status: response.status, astByTable: new Map(body.queries.map(({ id, ast }) => [id, ast])) }
}
const transform = (token: string, args: unknown[] = []) =>
  transformOf(
    token,
    replicatedTables.filter(({ name }) => !perChatReads[name]).map(({ name }) => ({ id: name, name, args })),
  )
const readPerChat = async (token: string, readOf: (chatId: string) => readonly [string, object]) => {
  const { astByTable } = await transformOf(
    token,
    allChatIds.map((chatId) => {
      const [name, args] = readOf(chatId)
      return { id: chatId, name, args: [args] }
    }),
  )
  return (await Promise.all([...astByTable.values()].map(rowsOf))).flat()
}

const readAll = async (workspace: string, user: string) => {
  const token = await tokenOf(workspace, user)
  const { astByTable } = await transform(token)
  return new Map(
    await Promise.all(
      replicatedTables.map(async (table) => {
        const readOf = perChatReads[table.name]
        const rows = readOf ? await readPerChat(token, readOf) : await rowsOf(astByTable.get(table.name) as AST)
        return [serverNameOf(table.name, table), rows] as const
      }),
    ),
  )
}

const expectedCount = async (table: string, workspace: string, user: string) => {
  const participatedChats = `select chat_id from chat_participants where workspace_id = '${workspace}' and user_id = '${user}'`
  const readableChats = `select id from chats where workspace_id = '${workspace}' and (visibility = 'public'
    or id in (${participatedChats}))`
  const userCondition = memberPrivateTables.includes(table) ? `and user_id = '${user}'` : ''
  const adminCondition = `or exists (select 1 from memberships where workspace_id = '${workspace}'
    and user_id = '${user}' and role = 'admin' and removed_at is null)`
  const chatCondition =
    table === 'chats'
      ? `and id in (${readableChats})`
      : serverSchema[table]?.chat_id
        ? `and chat_id in (${readableChats})`
        : chatOwnerConnectionTables.includes(table)
          ? `and (user_id = '${user}' or user_id in (select owner_user_id from chats where id in (${participatedChats}))
              ${table === 'connection_restrictions' ? adminCondition : ''})`
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
await testDatabase.database.$client`
  insert into workspace_connections (workspace_id, id, name, gateway_name, url, header_name, tools, allowed_tools)
  values (${acme}, 'connection-acme-crm', 'CRM', 'crm_api001', 'http://crm/mcp', null, '[]', '["lookup"]'),
    (${globex}, 'connection-globex-erp', 'ERP', 'erp_api001', 'http://erp/mcp', null, '[]', '[]')`
await testDatabase.database.$client`
  insert into connection_restrictions (workspace_id, connection_id, user_id, allowed_tools)
  values (${acme}, 'connection-acme-crm', ${bob}, '["lookup"]'), (${acme}, 'connection-acme-crm', ${lee}, '[]')`
await testDatabase.database.$client`
  insert into tool_connections (workspace_id, user_id, tool, status, position)
  values (${acme}, ${bob}, 'Linear', 'Connected', 0)`
const rowsByReader = new Map(
  await Promise.all(
    readers.map(async (reader) => [reader.name, await readAll(reader.workspace, reader.user)] as const),
  ),
)
const tenantTables = replicatedTables
  .map((table) => serverNameOf(table.name, table))
  .filter((table) => table !== 'users' && table !== 'workspaces')

test('there is one synced query per replicated table, messages, usage and pages read per chat or month, and messages searched by text', () => {
  expect(
    Object.keys(queries)
      .filter((key) => key !== '~')
      .sort(),
  ).toEqual(
    [
      ...replicatedTables.map(({ name }) => name).filter((name) => !perChatReads[name]),
      'latestMessages',
      'latestAgentActivity',
      'chatMessages',
      'chatPinnedSteps',
      'chatBrowserPages',
      'chatUsage',
      'monthUsage',
      'searchMessages',
    ].sort(),
  )
})

test.each(readers)(
  '$name reads the newest window, pinned steps and month usage only of the chats it may read',
  async (reader) => {
    const token = await tokenOf(reader.workspace, reader.user)
    const readableChatIds = new Set(
      rowsByReader
        .get(reader.name)
        ?.get('chats')
        ?.map((row) => row.id),
    )
    const month = new Date().toISOString().slice(0, 7)
    const roots = await readPerChat(token, (chatId) => ['chatMessages', { chatId, limit: 1 }])
    const pinned = await readPerChat(token, (chatId) => ['chatPinnedSteps', { chatId }])
    const { astByTable } = await transformOf(token, [{ id: 'month', name: 'monthUsage', args: [{ month }] }])
    const monthUsage = await rowsOf(astByTable.get('month') as AST)
    for (const row of [...roots, ...pinned, ...monthUsage]) expect(readableChatIds.has(row.chat_id)).toBe(true)
    expect(roots.length).toBeGreaterThan(0)
    expect(monthUsage).toEqual(
      (rowsByReader.get(reader.name)?.get('usage_entries') ?? []).filter((row) => row.month === month),
    )
  },
)

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

test('workspace connections are visible to every member of their workspace, a restriction to its member, to participants of their chats and to admins', () => {
  const columnOf = (reader: string, table: string, column: string) =>
    rowsByReader
      .get(reader)
      ?.get(table)
      ?.map((row) => row[column])
  for (const reader of ['Alice in Acme', 'Bob in Acme', 'Lee in Acme'])
    expect(columnOf(reader, 'workspace_connections', 'name')).toEqual(['CRM'])
  expect(columnOf('Alice in Globex', 'workspace_connections', 'name')).toEqual(['ERP'])
  expect(columnOf('Alice in Acme', 'connection_restrictions', 'user_id')?.toSorted()).toEqual([bob, lee])
  expect(columnOf('Bob in Acme', 'connection_restrictions', 'user_id')).toEqual([bob])
  expect(columnOf('Lee in Acme', 'connection_restrictions', 'user_id')).toEqual([lee])
  expect(columnOf('Alice in Globex', 'connection_restrictions', 'user_id')).toEqual([])
})

test('personal connections are visible to their member and to participants of the chats they own, not to every reader of a public channel', () => {
  const ownersOf = (reader: string) => [
    ...new Set(
      rowsByReader
        .get(reader)
        ?.get('tool_connections')
        ?.map((row) => row.user_id),
    ),
  ]
  expect(ownersOf('Alice in Acme').toSorted()).toEqual([alice, bob].toSorted())
  expect(ownersOf('Bob in Acme').toSorted()).toEqual([alice, bob].toSorted())
  expect(ownersOf('Lee in Acme')).toEqual([alice])
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
  expect(idsOf('Alice in Acme', 'users', 'id')).toEqual([alice, bob, lee])
  expect(idsOf('Alice in Globex', 'users', 'id')).toEqual([alice])
})

test('an ownership change hides the restriction of Bob from a member who no longer reads any chat of his', async () => {
  const restrictedOf = async (workspace: string, user: string) =>
    ((await readAll(workspace, user)).get('connection_restrictions') ?? []).map((row) => row.user_id).toSorted()
  expect(await restrictedOf(acme, lee)).toEqual([bob, lee])
  await testDatabase.database.$client`update chats set owner_user_id = ${alice} where owner_user_id = ${bob}`
  expect(await restrictedOf(acme, lee)).toEqual([lee])
  expect(await restrictedOf(acme, bob)).toEqual([bob])
  expect(await restrictedOf(acme, alice)).toEqual([bob, lee])
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
  expect(danaSession.userId).toBe('member-dana')
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
  const spyriaRuntimeAvailableFor = async (user: string) =>
    (
      (await (
        await app.request('/api/chats/chat-invoice-bug/routing', {
          headers: { authorization: `Bearer ${await tokenOf(acme, user)}` },
        })
      ).json()) as { spyriaRuntimeAvailable: boolean }
    ).spyriaRuntimeAvailable
  const addHost = (workspace: string, id: string, status: string, ownerId: string | null) =>
    testDatabase.database.$client`
      insert into runtime_hosts (workspace_id, id, name, status, running_runtimes, created_by, owner_id, created_at)
      values (${workspace}, ${id}, ${id}, ${status}, 0, ${alice}, ${ownerId}, now())`
  await addHost(acme, 'host-acme-offline', 'offline', null)
  await addHost(acme, 'host-bob-machine', 'online', bob)
  await addHost(globex, 'host-globex-online', 'online', null)
  expect(await spyriaRuntimeAvailableFor(bob)).toBe(false)
  await testDatabase.database.$client`update runtime_hosts set status = 'online' where id = 'host-acme-offline'`
  expect(await spyriaRuntimeAvailableFor(bob)).toBe(true)
  expect(await spyriaRuntimeAvailableFor(alice)).toBe(true)
  await testDatabase.database.$client`
    delete from runtime_hosts where id in ('host-acme-offline', 'host-bob-machine', 'host-globex-online')`
})

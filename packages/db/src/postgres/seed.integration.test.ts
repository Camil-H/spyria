import { afterAll, expect, test } from 'bun:test'
import { getTableName } from 'drizzle-orm'
import { allTables, resetDatabase } from './seed.ts'
import * as tables from './tables.ts'
import { createTestDatabase, databaseDropTimeoutMilliseconds } from './testing.ts'

const seededDatabase = await createTestDatabase()
const { database } = seededDatabase
afterAll(() => seededDatabase.drop(), databaseDropTimeoutMilliseconds)

const tablesTheSeedFills = [
  'browser_pages',
  'chat_participants',
  'chat_roles',
  'chats',
  'events',
  'llm_credentials',
  'memberships',
  'messages',
  'projects',
  'read_markers',
  'sources',
  'usage_entries',
  'usage_sync_marks',
  'users',
  'workspace_role_permissions',
  'workspace_roles',
  'workspaces',
]
const columnsSetAtEachSeed: Record<string, string[]> = { usage_sync_marks: ['logsSince'] }

const tableNameOf = (table: (typeof allTables)[number]): string => getTableName(table)
const withoutColumns = (row: Record<string, unknown>, columns: readonly string[]) =>
  Object.fromEntries(Object.entries(row).filter(([column]) => !columns.includes(column)))
const everyTableRows = async () =>
  Object.fromEntries(
    await Promise.all(
      allTables.map(async (table) => {
        const name = tableNameOf(table)
        const rows = (await database.select().from(table)).map((row) =>
          withoutColumns(row, columnsSetAtEachSeed[name] ?? []),
        )
        return [name, rows.map((row) => JSON.stringify(row)).toSorted()] as const
      }),
    ),
  )

test('every table the seed writes has rows, and no other table does', async () => {
  const counted = await Promise.all(
    allTables.map(async (table) => ({ name: tableNameOf(table), count: await database.$count(table) })),
  )
  expect(
    counted
      .filter(({ count }) => count > 0)
      .map(({ name }) => name)
      .toSorted(),
  ).toEqual(tablesTheSeedFills)
})

test('every message has its event with the same seq', async () => {
  const [messages, events] = await Promise.all([
    database.select().from(tables.messages).orderBy(tables.messages.id),
    database.select().from(tables.events).orderBy(tables.events.id),
  ])
  expect(
    events
      .filter(({ type }) => type === 'message.posted')
      .map(({ id, chatId, seq, actor }) => ({ id, chatId, seq, authorId: actor })),
  ).toEqual(messages.map(({ id, chatId, seq, authorId }) => ({ id, chatId, seq, authorId })))
})

test('every chat starts its events with chat.created, before its first message', async () => {
  const [chats, events] = await Promise.all([
    database.select().from(tables.chats).orderBy(tables.chats.id),
    database.select().from(tables.events).orderBy(tables.events.chatId, tables.events.seq),
  ])
  const firstEvents = [...Map.groupBy(events, (event) => event.chatId).values()].map(([first]) => first)
  expect(
    firstEvents.map(
      (event) =>
        event && { chatId: event.chatId, seq: event.seq, type: event.type, actor: event.actor, payload: event.payload },
    ),
  ).toEqual(
    chats.map(({ id, ownerUserId, name, type, projectId }) => ({
      chatId: id,
      seq: 1,
      type: 'chat.created',
      actor: ownerUserId,
      payload: { name, type, projectId },
    })),
  )
})

test('reset is idempotent and restores every seeded row after changes', async () => {
  const seeded = await everyTableRows()
  await database.delete(tables.readMarkers)
  await resetDatabase(database)
  await resetDatabase(database)
  expect(await everyTableRows()).toEqual(seeded)
})

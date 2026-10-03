import { afterAll, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { chats, events, messages, readMarkers } from './tables.ts'
import { createTestDatabase } from './test-database.ts'

const seededDatabase = await createTestDatabase()
const { database } = seededDatabase
afterAll(() => seededDatabase.drop())

const postgresErrorCode = (query: PromiseLike<unknown>) =>
  Promise.resolve(query).then(
    () => 'accepted',
    (error) => error.cause?.code ?? error.code,
  )

let nextSeq = 100

const message = (overrides: Partial<typeof messages.$inferInsert>) => ({
  workspaceId: 'workspace-globex',
  chatId: 'chat-general',
  id: `message-${crypto.randomUUID()}`,
  seq: nextSeq++,
  kind: 'member' as const,
  authorId: 'member-alice',
  body: 'Hello',
  createdAt: new Date(),
  ...overrides,
})

const event = (overrides: Partial<typeof events.$inferInsert>) => ({
  workspaceId: 'workspace-acme',
  chatId: 'chat-welcome',
  id: `event-${crypto.randomUUID()}`,
  seq: 100,
  type: 'message.posted',
  payload: {},
  createdAt: new Date(),
  ...overrides,
})

const crossTenantWrites = {
  'a message in a chat of another workspace': () =>
    database.insert(messages).values(message({ chatId: 'chat-welcome' })),
  'a message authored by a non-member of the workspace': () =>
    database.insert(messages).values(message({ authorId: 'member-bob' })),
  'a reply to a message of another workspace': () =>
    database.insert(messages).values(message({ replyToId: 'message-welcome-1' })),
  'a chat in a project of another workspace': () =>
    database.insert(chats).values({
      workspaceId: 'workspace-acme',
      id: 'chat-cross-tenant',
      projectId: 'project-launch',
      type: 'channel',
      ownerKind: 'user',
      ownerUserId: 'member-alice',
      name: 'Cross tenant',
      archived: false,
    }),
  'a read marker on a chat of another workspace': () =>
    database
      .insert(readMarkers)
      .values({ workspaceId: 'workspace-globex', userId: 'member-alice', chatId: 'chat-welcome', lastReadSeq: 1 }),
}

test('a same-tenant message is accepted', async () => {
  expect(await postgresErrorCode(database.insert(messages).values(message({})))).toBe('accepted')
})

test.each(Object.entries(crossTenantWrites))('refuses %s', async (_, write) => {
  expect(await postgresErrorCode(write())).toBe('23503')
})

test('refuses a duplicate (chat_id, seq) on messages and on events', async () => {
  expect(await postgresErrorCode(database.insert(messages).values(message({ seq: 1 })))).toBe('23505')
  expect(await postgresErrorCode(database.insert(events).values(event({ seq: 1 })))).toBe('23505')
})

test('rejects UPDATE and DELETE on events', async () => {
  expect(await postgresErrorCode(database.update(events).set({ type: 'edited' }).where(eq(events.seq, 1)))).toBe(
    'P0001',
  )
  expect(await postgresErrorCode(database.delete(events).where(eq(events.seq, 1)))).toBe('P0001')
  expect(await database.$count(events)).toBe(12)
})

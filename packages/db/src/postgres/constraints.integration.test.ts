import { afterAll, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { chatParticipants, chatRoles, chats, events, messages, readMarkers, threadReadMarkers } from './tables.ts'
import { createTestDatabase, databaseDropTimeoutMilliseconds } from './testing.ts'

const seededDatabase = await createTestDatabase()
const { database } = seededDatabase
afterAll(() => seededDatabase.drop(), databaseDropTimeoutMilliseconds)

const refusalOf = (query: PromiseLike<unknown>) =>
  Promise.resolve(query).then(
    () => 'accepted',
    (error) => error.cause ?? error,
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
  'a thread reply to a message of another workspace': () =>
    database.insert(messages).values(message({ threadRootId: 'message-welcome-1' })),
  'a thread read marker on a message of another workspace': () =>
    database.insert(threadReadMarkers).values({
      workspaceId: 'workspace-globex',
      userId: 'member-alice',
      chatId: 'chat-general',
      threadRootId: 'message-welcome-1',
      lastReadSeq: 1,
    }),
  'a chat in a project of another workspace': () =>
    database.insert(chats).values({
      workspaceId: 'workspace-acme',
      id: 'chat-cross-tenant',
      projectId: 'project-launch',
      type: 'channel',
      visibility: 'public',
      ownerKind: 'user',
      ownerUserId: 'member-alice',
      name: 'Cross tenant',
      archived: false,
      createdAt: new Date(),
    }),
  'a read marker on a chat of another workspace': () =>
    database
      .insert(readMarkers)
      .values({ workspaceId: 'workspace-globex', userId: 'member-alice', chatId: 'chat-welcome', lastReadSeq: 1 }),
  'a participant whose role is not in its workspace': () =>
    database
      .insert(chatParticipants)
      .values({ workspaceId: 'workspace-acme', chatId: 'chat-research', userId: 'member-bob', roleId: 'missing' }),
}

test('refuses a chat role without chat.read', async () => {
  expect(
    await refusalOf(
      database.insert(chatRoles).values({
        workspaceId: 'workspace-acme',
        id: 'poster',
        name: 'Poster',
        permissions: ['chat.post'],
        builtIn: false,
      }),
    ),
  ).toMatchObject({ code: '23514' })
})

test('a same-tenant message and thread reply are accepted', async () => {
  expect(await refusalOf(database.insert(messages).values(message({})))).toBe('accepted')
  expect(await refusalOf(database.insert(messages).values(message({ threadRootId: 'message-general-1' })))).toBe(
    'accepted',
  )
})

test.each(Object.entries(crossTenantWrites))('refuses %s', async (_, write) => {
  expect(await refusalOf(write())).toMatchObject({ code: '23503' })
})

test('refuses a duplicate (chat_id, seq) on messages and on events', async () => {
  expect(await refusalOf(database.insert(messages).values(message({ seq: 1 })))).toMatchObject({ code: '23505' })
  expect(await refusalOf(database.insert(events).values(event({ seq: 1 })))).toMatchObject({ code: '23505' })
})

test('rejects UPDATE and DELETE on events', async () => {
  expect(await refusalOf(database.update(events).set({ type: 'edited' }).where(eq(events.seq, 1)))).toMatchObject({
    code: 'P0001',
    message: 'events are append-only: UPDATE rejected',
  })
  expect(await refusalOf(database.delete(events).where(eq(events.seq, 1)))).toMatchObject({
    code: 'P0001',
    message: 'events are append-only: DELETE rejected',
  })
  expect(await database.$count(events)).toBe(12)
})

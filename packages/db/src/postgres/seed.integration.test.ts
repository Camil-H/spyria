import { afterAll, expect, test } from 'bun:test'
import { createMockSnapshot } from '../mock-data.ts'
import { resetDatabase } from './seed.ts'
import * as tables from './tables.ts'
import { createTestDatabase, databaseDropTimeoutMilliseconds } from './testing.ts'

const seededDatabase = await createTestDatabase()
const { database } = seededDatabase
afterAll(() => seededDatabase.drop(), databaseDropTimeoutMilliseconds)

const isoOrNull = (date: Date | null) => date?.toISOString() ?? null
const canonical = (row: object) =>
  JSON.stringify(Object.entries(row).sort(([first], [second]) => first.localeCompare(second)))
const unordered = (rows: readonly object[]) =>
  rows.toSorted((first, second) => canonical(first).localeCompare(canonical(second)))
const groupedByChat = <Row extends { chatId: string }>(rows: readonly Row[]) =>
  rows.toSorted((first, second) => first.chatId.localeCompare(second.chatId))
const userAsMember = <Row extends { userId: string }>({ userId, ...row }: Row) => ({ ...row, memberId: userId })

const readSnapshot = async () => {
  const [memberships, users, chats, messages, readMarkers] = await Promise.all([
    database.select().from(tables.memberships),
    database.select().from(tables.users),
    database.select().from(tables.chats).orderBy(tables.chats.createdAt),
    database.select().from(tables.messages).orderBy(tables.messages.chatId, tables.messages.seq),
    database.select().from(tables.readMarkers),
  ])
  const chatType = new Map(chats.map((chat) => [chat.id, chat.type]))
  const answeredIds = new Set(messages.map((message) => message.replyToId))
  return {
    workspaces: (await database.select().from(tables.workspaces)).map(({ workspaceId, name, localSessions }) => ({
      id: workspaceId,
      name,
      localSessions,
    })),
    memberships: memberships.map((membership) => ({
      ...userAsMember(membership),
      email: users.find((user) => user.id === membership.userId)?.email,
    })),
    invitations: await database.select().from(tables.invitations),
    projects: (await database.select().from(tables.projects).orderBy(tables.projects.createdAt)).map(
      ({ createdAt, ...project }) => project,
    ),
    chats: chats.map(
      ({
        ownerUserId,
        ownerKind,
        ownerServiceIdentityId,
        mode,
        createdAt,
        agentTurnPrompterId,
        agentTurnFailure,
        agentModel,
        agentReasoningEffort,
        ...chat
      }) => ({
        ...chat,
        ownerId: ownerUserId,
      }),
    ),
    messages: messages.map(({ replyToId, createdAt, editedAt, deletedAt, ...message }) => ({
      ...message,
      createdAt: createdAt.toISOString(),
      editedAt: isoOrNull(editedAt),
      deletedAt: isoOrNull(deletedAt),
      needsReply:
        chatType.get(message.chatId) === 'runtime' && message.kind === 'member' && !answeredIds.has(message.id),
    })),
    readMarkers: readMarkers.map(userAsMember),
    threadReadMarkers: (await database.select().from(tables.threadReadMarkers)).map(userAsMember),
    runtimeOrigins: await database.select().from(tables.runtimeOrigins),
    llmCredentials: (await database.select().from(tables.llmCredentials)).map(({ secretRef, ...credential }) =>
      userAsMember(credential),
    ),
    workspaceConnections: (
      await database.select().from(tables.workspaceConnections).orderBy(tables.workspaceConnections.position)
    ).map(({ position, ...connection }) => userAsMember(connection)),
    toolConnections: (
      await database.select().from(tables.toolConnections).orderBy(tables.toolConnections.position)
    ).map(({ position, ...connection }) => userAsMember(connection)),
    chatMembers: (await database.select().from(tables.chatParticipants)).map(userAsMember),
    chatRoles: await database.select().from(tables.chatRoles),
    files: await database.select().from(tables.files),
    changes: await database.select().from(tables.changes),
    terminalLines: (
      await database
        .select()
        .from(tables.terminalLines)
        .orderBy(tables.terminalLines.chatId, tables.terminalLines.position)
    ).map(({ position, ...line }) => line),
    planSteps: (
      await database.select().from(tables.planSteps).orderBy(tables.planSteps.chatId, tables.planSteps.position)
    ).map(({ position, ...step }) => step),
    commits: (await database.select().from(tables.commits)).map(({ committedAt, ...commit }) => ({
      ...commit,
      committedAt: committedAt.toISOString(),
    })),
    browserPages: await database.select().from(tables.browserPages),
    sources: await database.select().from(tables.sources),
    usageEntries: (await database.select().from(tables.usageEntries)).map(userAsMember),
    runtimeHosts: await database.select().from(tables.runtimeHosts),
    runtimes: await database.select().from(tables.runtimes),
  }
}

const expectSnapshotRoundTrip = async () => {
  const {
    drafts,
    projects,
    chats,
    messages,
    terminalLines,
    planSteps,
    workspaceConnections,
    toolConnections,
    ...unorderedCollections
  } = createMockSnapshot()
  const stored = await readSnapshot()
  expect(stored.workspaceConnections).toEqual([...workspaceConnections])
  expect(stored.toolConnections).toEqual([...toolConnections])
  expect(stored.projects).toEqual([...projects])
  expect(stored.chats).toEqual([...chats])
  expect(stored.messages).toEqual(groupedByChat(messages).map(({ replyToId, ...message }) => message))
  expect(stored.terminalLines).toEqual(groupedByChat(terminalLines))
  expect(stored.planSteps).toEqual(groupedByChat(planSteps))
  for (const [name, rows] of Object.entries(unorderedCollections))
    expect({ [name]: unordered(stored[name as keyof typeof unorderedCollections]) }).toEqual({
      [name]: unordered(rows),
    })
}

test('the seed stores exactly the mock snapshot', async () => {
  await expectSnapshotRoundTrip()
})

test('every message has its event with the same seq', async () => {
  const [messages, events] = await Promise.all([
    database.select().from(tables.messages).orderBy(tables.messages.id),
    database.select().from(tables.events).orderBy(tables.events.id),
  ])
  expect(events.map(({ id, chatId, seq, actor }) => ({ id, chatId, seq, authorId: actor }))).toEqual(
    messages.map(({ id, chatId, seq, authorId }) => ({ id, chatId, seq, authorId })),
  )
})

test('reset is idempotent and restores the snapshot after changes', async () => {
  await database.delete(tables.readMarkers)
  await resetDatabase(database)
  await resetDatabase(database)
  await expectSnapshotRoundTrip()
})

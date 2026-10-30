import { afterAll, expect, test } from 'bun:test'
import { workspacePermissions } from '@spyria/kernel'
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
  const grantedPermissions = await database.select().from(tables.workspaceRolePermissions)
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
    workspaces: (await database.select().from(tables.workspaces)).map(
      ({ workspaceId, name, localSessions, aiProviderAllowList, devLoop, setupCommands }) => ({
        id: workspaceId,
        name,
        localSessions,
        aiProviderAllowList,
        devLoop,
        setupCommands: setupCommands ?? [],
      }),
    ),
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
    ssoDomains: (await database.select().from(tables.ssoDomains)).map(({ workspaceId, domain, verifiedAt }) => ({
      workspaceId,
      domain,
      isVerified: verifiedAt !== null,
    })),
    githubApps: (await database.select().from(tables.githubApps)).map(({ workspaceId }) => ({ workspaceId })),
    githubConnections: (await database.select().from(tables.githubConnections)).map(({ workspaceId, userId }) => ({
      workspaceId,
      memberId: userId,
    })),
    workspaceOnboarding: (await database.select().from(tables.workspaceOnboarding)).map(({ workspaceId, task }) => ({
      workspaceId,
      task,
    })),
    memberOnboarding: (await database.select().from(tables.memberOnboarding)).map(
      ({ workspaceId, userId, task, completedAt, skippedAt }) => ({
        workspaceId,
        memberId: userId,
        task,
        isCompleted: completedAt !== null,
        isSkipped: skippedAt !== null,
      }),
    ),
    workspaceConnections: await database.select().from(tables.workspaceConnections),
    connectionRestrictions: (await database.select().from(tables.connectionRestrictions)).map(userAsMember),
    toolConnections: (
      await database.select().from(tables.toolConnections).orderBy(tables.toolConnections.position)
    ).map(({ position, ...connection }) => userAsMember(connection)),
    chatMembers: (await database.select().from(tables.chatParticipants)).map(userAsMember),
    chatRoles: await database.select().from(tables.chatRoles),
    workspaceRoles: (await database.select().from(tables.workspaceRoles)).map((role) => ({
      ...role,
      permissions: workspacePermissions.filter((permission) =>
        grantedPermissions.some(
          (granted) =>
            granted.workspaceId === role.workspaceId && granted.roleId === role.id && granted.permission === permission,
        ),
      ),
    })),
    browserPages: (await database.select().from(tables.browserPages)).map(({ openedAt, ...page }) => ({
      ...page,
      openedAt: openedAt.toISOString(),
    })),
    sources: await database.select().from(tables.sources),
    usageEntries: (await database.select().from(tables.usageEntries)).map(userAsMember),
    budgetAlerts: (await database.select().from(tables.budgetAlerts)).map(({ reachedAt, ...alert }) => alert),
    runtimeHosts: await database.select().from(tables.runtimeHosts),
    machineCounts: await database.select().from(tables.machineCounts),
    runtimes: await database.select().from(tables.runtimes),
  }
}

const expectSnapshotRoundTrip = async () => {
  const {
    latestMessages,
    latestAgentActivity,
    pinnedSteps,
    projects,
    chats,
    messages,
    toolConnections,
    ...unorderedCollections
  } = createMockSnapshot()
  const stored = await readSnapshot()
  expect(stored.toolConnections).toEqual([...toolConnections])
  expect(stored.projects).toEqual([...projects])
  expect(stored.chats).toEqual([...chats])
  expect(stored.messages).toEqual(groupedByChat(messages).map(({ replyToId, ...message }) => message))
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

test('reset is idempotent and restores the snapshot after changes', async () => {
  await database.delete(tables.readMarkers)
  await resetDatabase(database)
  await resetDatabase(database)
  await expectSnapshotRoundTrip()
})

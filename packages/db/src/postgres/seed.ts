import { getTableName, is, sql } from 'drizzle-orm'
import { PgTable } from 'drizzle-orm/pg-core'
import { createMockSnapshot } from '../mock-data.ts'
import type { Snapshot } from '../schema.ts'
import { createDatabase, type Database } from './client.ts'
import * as tables from './tables.ts'

type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0]

export const allTables = Object.values(tables).filter((value) => is(value, PgTable))

const numberedWithinChat = <Row extends { workspaceId: string; chatId: string }>(rows: readonly Row[]) => {
  const countByChat = new Map<string, number>()
  return rows.map((row) => {
    const chatKey = `${row.workspaceId}/${row.chatId}`
    const number = (countByChat.get(chatKey) ?? 0) + 1
    countByChat.set(chatKey, number)
    return { row, number }
  })
}

const seedCreationEpoch = Date.parse('2026-01-01T00:00:00Z')
const createdInOrder = <Row>(row: Row, index: number) => ({
  ...row,
  createdAt: new Date(seedCreationEpoch + index * 1000),
})

const withUserId = <Row extends { memberId: string }>({ memberId, ...row }: Row) => ({ ...row, userId: memberId })

const withUserIdAndPosition = <Row extends { memberId: string }>(row: Row, index: number) => ({
  ...withUserId(row),
  position: index + 1,
})

const replyTargets = (snapshot: Snapshot) => {
  const replyToByMessageId = new Map<string, string>()
  const answeredMessageIdByChat = new Map<string, string | null>()
  for (const message of snapshot.messages) {
    if (message.kind === 'member') answeredMessageIdByChat.set(message.chatId, message.needsReply ? null : message.id)
    const answeredMessageId = answeredMessageIdByChat.get(message.chatId)
    if (message.kind === 'agent' && answeredMessageId) {
      replyToByMessageId.set(message.id, answeredMessageId)
      answeredMessageIdByChat.set(message.chatId, null)
    }
  }
  return replyToByMessageId
}

const insertSnapshot = async (transaction: Transaction, snapshot: Snapshot) => {
  const memberName = new Map(snapshot.members.map((member) => [member.id, member.name]))
  const creatorByWorkspace = new Map(
    snapshot.memberships.toReversed().map((membership) => [membership.workspaceId, membership.memberId]),
  )
  const numberedMessages = numberedWithinChat(snapshot.messages)
  const seqByMessageId = new Map(numberedMessages.map(({ row, number }) => [row.id, number]))
  const replyToByMessageId = replyTargets(snapshot)
  await transaction
    .insert(tables.users)
    .values(snapshot.members.map((member) => ({ id: member.id, email: `${member.name.toLowerCase()}@example.com` })))
  await transaction
    .insert(tables.workspaces)
    .values(
      snapshot.workspaces.map((workspace, index) =>
        createdInOrder(
          { workspaceId: workspace.id, name: workspace.name, createdBy: creatorByWorkspace.get(workspace.id) ?? '' },
          index,
        ),
      ),
    )
  await transaction.insert(tables.memberships).values(
    snapshot.memberships.map((membership) => ({
      workspaceId: membership.workspaceId,
      userId: membership.memberId,
      role:
        creatorByWorkspace.get(membership.workspaceId) === membership.memberId
          ? ('admin' as const)
          : ('member' as const),
      displayName: memberName.get(membership.memberId) ?? '',
    })),
  )
  await transaction.insert(tables.projects).values(snapshot.projects.map(createdInOrder))
  await transaction.insert(tables.chats).values(
    snapshot.chats.map(({ ownerId, ...chat }, index) => ({
      ...createdInOrder(chat, index),
      mode: null,
      ownerKind: 'user' as const,
      ownerUserId: ownerId,
      ownerServiceIdentityId: null,
    })),
  )
  await transaction.insert(tables.chatParticipants).values(snapshot.chatMembers.map(withUserId))
  await transaction.insert(tables.messages).values(
    numberedMessages.map(({ row: { needsReply, createdAt, editedAt, deletedAt, ...message }, number }) => ({
      ...message,
      seq: number,
      replyToId: replyToByMessageId.get(message.id) ?? null,
      createdAt: new Date(createdAt),
      editedAt: editedAt === null ? null : new Date(editedAt),
      deletedAt: deletedAt === null ? null : new Date(deletedAt),
    })),
  )
  await transaction.insert(tables.events).values(
    numberedMessages.map(({ row: message, number }) => ({
      workspaceId: message.workspaceId,
      chatId: message.chatId,
      id: message.id,
      seq: number,
      type: 'message.posted',
      actor: message.authorId,
      payload: {
        kind: message.kind,
        body: message.body,
        detail: message.detail,
        replyToId: replyToByMessageId.get(message.id) ?? null,
      },
      createdAt: new Date(message.createdAt),
    })),
  )
  await transaction.insert(tables.readMarkers).values(
    snapshot.readMarkers.map(({ lastReadMessageId, ...marker }) => ({
      ...withUserId(marker),
      lastReadSeq: seqByMessageId.get(lastReadMessageId) ?? 0,
    })),
  )
  await transaction.insert(tables.llmCredentials).values(
    snapshot.llmCredentials.map((credential) => ({
      ...withUserId(credential),
      secretRef: `gateway:${credential.id}`,
    })),
  )
  await transaction.insert(tables.workspaceConnections).values(snapshot.workspaceConnections.map(withUserIdAndPosition))
  await transaction.insert(tables.toolConnections).values(snapshot.toolConnections.map(withUserIdAndPosition))
  await transaction.insert(tables.files).values([...snapshot.files])
  await transaction.insert(tables.changes).values([...snapshot.changes])
  await transaction
    .insert(tables.terminalLines)
    .values(numberedWithinChat(snapshot.terminalLines).map(({ row, number }) => ({ ...row, position: number })))
  await transaction
    .insert(tables.planSteps)
    .values(numberedWithinChat(snapshot.planSteps).map(({ row, number }) => ({ ...row, position: number })))
  await transaction
    .insert(tables.commits)
    .values(snapshot.commits.map(({ committedAt, ...commit }) => ({ ...commit, committedAt: new Date(committedAt) })))
  await transaction.insert(tables.browserPages).values([...snapshot.browserPages])
  await transaction.insert(tables.sources).values([...snapshot.sources])
  await transaction.insert(tables.usageEntries).values(snapshot.usageEntries.map(withUserId))
}

export const seedDatabase = (database: Database, snapshot = createMockSnapshot()) =>
  database.transaction((transaction) => insertSnapshot(transaction, snapshot))

export const resetDatabase = (
  database: Database,
  snapshot = createMockSnapshot(),
  afterSeed: (transaction: Transaction) => Promise<unknown> = async () => {},
) =>
  database.transaction(async (transaction) => {
    await transaction.execute(
      sql.raw(`truncate ${allTables.map((table) => `"${getTableName(table)}"`).join(', ')} restart identity cascade`),
    )
    await insertSnapshot(transaction, snapshot)
    await afterSeed(transaction)
  })

if (import.meta.main) {
  const database = createDatabase()
  const shouldReset = process.argv.includes('--reset')
  await (shouldReset ? resetDatabase : seedDatabase)(database)
  await database.$client.end()
  console.log(shouldReset ? 'database reset and seeded' : 'database seeded')
}

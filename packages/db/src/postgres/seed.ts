import { getTableName, is, sql } from 'drizzle-orm'
import { PgTable } from 'drizzle-orm/pg-core'
import { createMockSnapshot } from '../mock-data.ts'
import type { Snapshot } from '../schema.ts'
import { createDatabase, type Database } from './client.ts'
import * as tables from './tables.ts'

type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0]

export const allTables = Object.values(tables).filter((value) => is(value, PgTable))

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

const insertSnapshot = async (transaction: Transaction, snapshot: Snapshot) => {
  const creatorByWorkspace = new Map(
    snapshot.memberships.toReversed().map((membership) => [membership.workspaceId, membership.memberId]),
  )
  const emailByUserId = new Map(snapshot.memberships.map((membership) => [membership.memberId, membership.email]))
  await transaction.insert(tables.users).values([...emailByUserId].map(([id, email]) => ({ id, email })))
  await transaction
    .insert(tables.workspaces)
    .values(
      snapshot.workspaces.map(({ id, ...workspace }, index) =>
        createdInOrder({ ...workspace, workspaceId: id, createdBy: creatorByWorkspace.get(id) ?? '' }, index),
      ),
    )
  await transaction
    .insert(tables.workspaceRoles)
    .values(snapshot.workspaceRoles.map(({ permissions, ...role }) => role))
  await transaction
    .insert(tables.workspaceRolePermissions)
    .values(
      snapshot.workspaceRoles.flatMap(({ workspaceId, id, permissions }) =>
        permissions.map((permission) => ({ workspaceId, roleId: id, permission })),
      ),
    )
  await transaction.insert(tables.memberships).values(
    snapshot.memberships.map(({ memberId, email, removedAt, ...membership }) => ({
      ...membership,
      userId: memberId,
      removedAt: removedAt === null ? null : new Date(removedAt),
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
  await transaction
    .insert(tables.chatRoles)
    .values(snapshot.chatRoles.map((role) => ({ ...role, permissions: [...role.permissions] })))
  await transaction.insert(tables.chatParticipants).values(snapshot.chatMembers.map(withUserId))
  await transaction.insert(tables.messages).values(
    snapshot.messages.map(({ needsReply, createdAt, editedAt, deletedAt, ...message }) => ({
      ...message,
      createdAt: new Date(createdAt),
      editedAt: editedAt === null ? null : new Date(editedAt),
      deletedAt: deletedAt === null ? null : new Date(deletedAt),
    })),
  )
  await transaction.insert(tables.events).values(
    snapshot.messages.map((message) => ({
      workspaceId: message.workspaceId,
      chatId: message.chatId,
      id: message.id,
      seq: message.seq,
      type: 'message.posted',
      actor: message.authorId,
      payload: {
        kind: message.kind,
        body: message.body,
        detail: message.detail,
        step: message.step,
        replyToId: message.replyToId,
      },
      createdAt: new Date(message.createdAt),
    })),
  )
  await transaction.insert(tables.readMarkers).values(snapshot.readMarkers.map(withUserId))
  if (snapshot.llmCredentials.length > 0)
    await transaction.insert(tables.llmCredentials).values(
      snapshot.llmCredentials.map((credential) => ({
        ...withUserId(credential),
        secretRef: `gateway:${credential.id}`,
      })),
    )
  await transaction.insert(tables.toolConnections).values(snapshot.toolConnections.map(withUserIdAndPosition))
  await transaction.insert(tables.browserPages).values([...snapshot.browserPages])
  await transaction.insert(tables.sources).values([...snapshot.sources])
  await transaction.insert(tables.usageEntries).values(snapshot.usageEntries.map(withUserId))
  await transaction
    .insert(tables.usageSyncMarks)
    .values(snapshot.workspaces.map((workspace) => ({ workspaceId: workspace.id, logsSince: new Date() })))
}

export const resetDatabase = (
  database: Database,
  afterSeed: (transaction: Transaction) => Promise<unknown> = async () => {},
  snapshot: Snapshot = createMockSnapshot(),
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
  const isSeeded = !shouldReset && (await database.$count(tables.users)) > 0
  if (!isSeeded) await resetDatabase(database, undefined, { ...createMockSnapshot(), llmCredentials: [] })
  await database.$client.end()
  console.log(
    isSeeded
      ? 'database already seeded; run bun run db:reset to wipe it and seed again'
      : shouldReset
        ? 'database reset and seeded'
        : 'database seeded',
  )
}

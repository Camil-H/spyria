import { type ChatId, DomainError, type MemberId, permissionsOf, type WorkspaceId } from '@hq/kernel'
import {
  createBuilder,
  defineQueries,
  defineQuery,
  type Query,
  type ServerTransaction,
  type Transaction,
} from '@rocicorp/zero'
import { type Schema, schema } from './zero.ts'

export type ZeroContext = {
  userId: MemberId
  workspaceId: WorkspaceId
  hqAgentImage?: string
}

export type Transact = <Result>(work: (tx: ServerTransaction) => Promise<Result>) => Promise<Result>
export type Job = { workspaceId: WorkspaceId; payload: unknown; isLastAttempt: boolean; transact: Transact }

export const zql = createBuilder(schema)

export const skippingRefusedRebase = <Result>(tx: Transaction, work: () => Promise<Result>) =>
  tx.location === 'client' && tx.reason === 'rebase'
    ? work().catch((error: unknown) => {
        if (error instanceof DomainError) return undefined as Result
        throw error
      })
    : work()

declare module '@rocicorp/zero' {
  interface DefaultTypes {
    context: ZeroContext
  }
}

const readableBy = (userId: MemberId) => (chat: Query<'chats', Schema>) =>
  chat.where(({ or, cmp, exists }) =>
    or(
      cmp('visibility', 'public'),
      exists('participants', (participant) => participant.where('userId', userId)),
    ),
  )

const activeAdmin = (userId: MemberId) => (membership: Query<'memberships', Schema>) =>
  membership.where('userId', userId).where('role', 'admin').where('removedAt', 'IS', null)

export const activeMemberRoleOf = async (tx: Transaction, workspaceId: WorkspaceId, userId: MemberId) =>
  (
    await tx.run(
      zql.memberships.where('workspaceId', workspaceId).where('userId', userId).where('removedAt', 'IS', null).one(),
    )
  )?.role

export const isOwnerRemoved = async (tx: Transaction, workspaceId: WorkspaceId, ownerId: string | null) =>
  ownerId !== null &&
  (await tx.run(
    zql.memberships.where('workspaceId', workspaceId).where('userId', ownerId).where('removedAt', 'IS NOT', null).one(),
  )) !== undefined

export const chatPermissionsOf = (tx: Transaction, workspaceId: WorkspaceId) => ({
  permissions: async (chatId: ChatId, memberId: MemberId) => {
    const chat = await tx.run(
      zql.chats
        .where('workspaceId', workspaceId)
        .where('id', chatId)
        .related('participants', (participant) => participant.where('userId', memberId).related('role'))
        .one(),
    )
    return chat ? permissionsOf(chat, chat.participants[0]?.role) : []
  },
})

export const queries = defineQueries({
  users: defineQuery(({ ctx }) =>
    zql.users.whereExists('memberships', (membership) =>
      membership.where('workspaceId', ctx.workspaceId).where('removedAt', 'IS', null),
    ),
  ),
  workspaces: defineQuery(({ ctx }) =>
    zql.workspaces
      .whereExists('memberships', (membership) => membership.where('userId', ctx.userId).where('removedAt', 'IS', null))
      .orderBy('createdAt', 'asc'),
  ),
  memberships: defineQuery(({ ctx }) => zql.memberships.where('workspaceId', ctx.workspaceId)),
  invitations: defineQuery(({ ctx }) =>
    zql.invitations
      .where('workspaceId', ctx.workspaceId)
      .where('revokedAt', 'IS', null)
      .where('acceptedAt', 'IS', null)
      .whereExists('memberships', activeAdmin(ctx.userId))
      .orderBy('createdAt', 'asc'),
  ),
  serviceIdentities: defineQuery(({ ctx }) => zql.serviceIdentities.where('workspaceId', ctx.workspaceId)),
  projects: defineQuery(({ ctx }) => zql.projects.where('workspaceId', ctx.workspaceId).orderBy('createdAt', 'asc')),
  chats: defineQuery(({ ctx }) =>
    readableBy(ctx.userId)(zql.chats.where('workspaceId', ctx.workspaceId)).orderBy('createdAt', 'asc'),
  ),
  chatRoles: defineQuery(({ ctx }) => zql.chatRoles.where('workspaceId', ctx.workspaceId)),
  chatParticipants: defineQuery(({ ctx }) =>
    zql.chatParticipants.where('workspaceId', ctx.workspaceId).whereExists('chat', readableBy(ctx.userId)),
  ),
  messages: defineQuery(({ ctx }) =>
    zql.messages
      .where('workspaceId', ctx.workspaceId)
      .whereExists('chat', readableBy(ctx.userId))
      .orderBy('chatId', 'asc')
      .orderBy('seq', 'asc'),
  ),
  readMarkers: defineQuery(({ ctx }) =>
    zql.readMarkers
      .where('workspaceId', ctx.workspaceId)
      .where('userId', ctx.userId)
      .whereExists('chat', readableBy(ctx.userId)),
  ),
  threadReadMarkers: defineQuery(({ ctx }) =>
    zql.threadReadMarkers
      .where('workspaceId', ctx.workspaceId)
      .where('userId', ctx.userId)
      .whereExists('chat', readableBy(ctx.userId)),
  ),
  runtimeOrigins: defineQuery(({ ctx }) =>
    zql.runtimeOrigins.where('workspaceId', ctx.workspaceId).whereExists('chat', readableBy(ctx.userId)),
  ),
  llmCredentials: defineQuery(({ ctx }) =>
    zql.llmCredentials.where('workspaceId', ctx.workspaceId).where('userId', ctx.userId),
  ),
  workspaceConnections: defineQuery(({ ctx }) =>
    zql.workspaceConnections.where('workspaceId', ctx.workspaceId).orderBy('name', 'asc'),
  ),
  connectionRestrictions: defineQuery(({ ctx }) =>
    zql.connectionRestrictions
      .where('workspaceId', ctx.workspaceId)
      .where(({ or, cmp, exists }) =>
        or(
          cmp('userId', ctx.userId),
          exists('ownedChats', readableBy(ctx.userId)),
          exists('memberships', activeAdmin(ctx.userId)),
        ),
      ),
  ),
  toolConnections: defineQuery(({ ctx }) =>
    zql.toolConnections
      .where('workspaceId', ctx.workspaceId)
      .where(({ or, cmp, exists }) => or(cmp('userId', ctx.userId), exists('ownedChats', readableBy(ctx.userId))))
      .orderBy('position', 'asc'),
  ),
  planSteps: defineQuery(({ ctx }) =>
    zql.planSteps.where('workspaceId', ctx.workspaceId).whereExists('chat', readableBy(ctx.userId)),
  ),
  browserPages: defineQuery(({ ctx }) =>
    zql.browserPages.where('workspaceId', ctx.workspaceId).whereExists('chat', readableBy(ctx.userId)),
  ),
  sources: defineQuery(({ ctx }) =>
    zql.sources.where('workspaceId', ctx.workspaceId).whereExists('chat', readableBy(ctx.userId)),
  ),
  usageEntries: defineQuery(({ ctx }) =>
    zql.usageEntries.where('workspaceId', ctx.workspaceId).whereExists('chat', readableBy(ctx.userId)),
  ),
  runtimeHosts: defineQuery(({ ctx }) =>
    zql.runtimeHosts
      .where('workspaceId', ctx.workspaceId)
      .where(({ or, and, cmp, exists }) =>
        or(cmp('ownerId', ctx.userId), and(cmp('ownerId', 'IS', null), exists('memberships', activeAdmin(ctx.userId)))),
      )
      .where('removedAt', 'IS', null)
      .orderBy('createdAt', 'asc'),
  ),
  runtimes: defineQuery(({ ctx }) =>
    zql.runtimes.where('workspaceId', ctx.workspaceId).whereExists('chat', readableBy(ctx.userId)),
  ),
})

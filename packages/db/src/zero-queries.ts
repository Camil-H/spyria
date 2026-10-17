import { type ChatId, type MemberId, permissionsOf, type WorkspaceId } from '@hq/kernel'
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
  role: 'admin' | 'member'
  hqAgentImage?: string
}

export type Transact = <Result>(work: (tx: ServerTransaction) => Promise<Result>) => Promise<Result>
export type Job = { workspaceId: WorkspaceId; payload: unknown; isLastAttempt: boolean; transact: Transact }

export const zql = createBuilder(schema)

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

export const memberChatPermissions = async (
  tx: Transaction,
  workspaceId: WorkspaceId,
  chatId: ChatId,
  memberId: MemberId,
) => {
  const chat = await tx.run(
    zql.chats
      .where('workspaceId', workspaceId)
      .where('id', chatId)
      .related('participants', (participant) => participant.where('userId', memberId).related('role'))
      .one(),
  )
  return chat ? permissionsOf(chat, chat.participants[0]?.role) : []
}

export const queries = defineQueries({
  users: defineQuery(({ ctx }) =>
    zql.users.whereExists('memberships', (membership) => membership.where('workspaceId', ctx.workspaceId)),
  ),
  workspaces: defineQuery(({ ctx }) =>
    zql.workspaces
      .whereExists('memberships', (membership) => membership.where('userId', ctx.userId))
      .orderBy('createdAt', 'asc'),
  ),
  memberships: defineQuery(({ ctx }) => zql.memberships.where('workspaceId', ctx.workspaceId)),
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
  llmCredentials: defineQuery(({ ctx }) =>
    zql.llmCredentials.where('workspaceId', ctx.workspaceId).where('userId', ctx.userId),
  ),
  workspaceConnections: defineQuery(({ ctx }) =>
    zql.workspaceConnections
      .where('workspaceId', ctx.workspaceId)
      .where(({ or, cmp, exists }) => or(cmp('userId', ctx.userId), exists('ownedChats', readableBy(ctx.userId))))
      .orderBy('position', 'asc'),
  ),
  toolConnections: defineQuery(({ ctx }) =>
    zql.toolConnections
      .where('workspaceId', ctx.workspaceId)
      .where(({ or, cmp, exists }) => or(cmp('userId', ctx.userId), exists('ownedChats', readableBy(ctx.userId))))
      .orderBy('position', 'asc'),
  ),
  files: defineQuery(({ ctx }) =>
    zql.files.where('workspaceId', ctx.workspaceId).whereExists('chat', readableBy(ctx.userId)),
  ),
  changes: defineQuery(({ ctx }) =>
    zql.changes.where('workspaceId', ctx.workspaceId).whereExists('chat', readableBy(ctx.userId)),
  ),
  terminalLines: defineQuery(({ ctx }) =>
    zql.terminalLines.where('workspaceId', ctx.workspaceId).whereExists('chat', readableBy(ctx.userId)),
  ),
  planSteps: defineQuery(({ ctx }) =>
    zql.planSteps.where('workspaceId', ctx.workspaceId).whereExists('chat', readableBy(ctx.userId)),
  ),
  commits: defineQuery(({ ctx }) =>
    zql.commits.where('workspaceId', ctx.workspaceId).whereExists('chat', readableBy(ctx.userId)),
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
      .where(({ or, and, cmp, cmpLit }) =>
        or(cmp('ownerId', ctx.userId), and(cmpLit(ctx.role, '=', 'admin'), cmp('ownerId', 'IS', null))),
      )
      .where('removedAt', 'IS', null)
      .orderBy('createdAt', 'asc'),
  ),
  runtimes: defineQuery(({ ctx }) =>
    zql.runtimes.where('workspaceId', ctx.workspaceId).whereExists('chat', readableBy(ctx.userId)),
  ),
})

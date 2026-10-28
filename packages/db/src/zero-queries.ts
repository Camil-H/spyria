import {
  createBuilder,
  defineQueries,
  defineQuery,
  type Query,
  type ServerTransaction,
  type Transaction,
} from '@rocicorp/zero'
import {
  type ChatId,
  DomainError,
  type MemberId,
  permissionsOf,
  type Transactor,
  type WorkspaceId,
  type WorkspacePermission,
} from '@spyria/kernel'
import { z } from 'zod/mini'
import { type Schema, schema } from './zero.ts'

export type ZeroContext = {
  userId: MemberId
  workspaceId: WorkspaceId
  spyriaAgentImage?: string
  limitMessage?: (isPrompt: boolean) => void
}

export type Transact = <Result>(work: (tx: ServerTransaction) => Promise<Result>) => Promise<Result>
export type Job = {
  workspaceId: WorkspaceId
  payload: unknown
  isLastAttempt: boolean
  isRetry?: boolean
  transact: Transact
}

export const zql = createBuilder(schema)

const skippingRefusedRebase = <Result>(tx: Transaction, work: () => Promise<Result>) =>
  tx.location === 'client' && tx.reason === 'rebase'
    ? work().catch((error: unknown) => {
        if (error instanceof DomainError) return undefined as Result
        throw error
      })
    : work()

export const transactorOver = <UnitOfWork>(tx: Transaction, unitOfWork: UnitOfWork): Transactor<UnitOfWork> => ({
  run: (work) => skippingRefusedRebase(tx, () => work(unitOfWork)),
})

export const transactingTransactor = <UnitOfWork>(
  transact: Transact,
  transactorOf: (tx: Transaction) => Transactor<UnitOfWork>,
): Transactor<UnitOfWork> => ({
  run: (work) => transact((tx) => transactorOf(tx).run(work)),
})

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

const id = z.string().check(z.minLength(1))
export const pinnedStepTypes = ['question', 'pull_request']
export const searchTextMinimumLength = 2
export const searchResultLimit = 30
export const searchTextMaximumLength = 200
const searchText = z.string().check(z.minLength(searchTextMinimumLength), z.maxLength(searchTextMaximumLength))
export const likeEscaped = (text: string) => text.replace(/[\\%_]/g, '\\$&')
export const caseVariantsOf = (text: string) => {
  const lowered = text.toLowerCase()
  if (!/[^\p{ASCII}]/u.test(lowered)) return [lowered]
  const titled = lowered.replace(/(^|\s)(\S)/gu, (_, space: string, letter: string) => space + letter.toUpperCase())
  return [...new Set([lowered, titled, lowered.toUpperCase()])]
}

const messagesOf = (ctx: ZeroContext, chatId: string) =>
  zql.messages.where('workspaceId', ctx.workspaceId).where('chatId', chatId).whereExists('chat', readableBy(ctx.userId))

const activeMember = (userId: MemberId) => (membership: Query<'memberships', Schema>) =>
  membership.where('userId', userId).where('removedAt', 'IS', null)

const activeMemberWith =
  (userId: MemberId, permission: WorkspacePermission) => (membership: Query<'memberships', Schema>) =>
    activeMember(userId)(membership).whereExists('workspaceRole', (role) =>
      role.whereExists('permissions', (granted) => granted.where('permission', permission)),
    )

export const workspacePermissionsOf = async (tx: Transaction, workspaceId: WorkspaceId, userId: MemberId) => {
  const membership = await tx.run(
    activeMember(userId)(zql.memberships.where('workspaceId', workspaceId))
      .related('workspaceRole', (role) => role.related('permissions'))
      .one(),
  )
  return membership?.workspaceRole?.permissions.map((granted) => granted.permission as WorkspacePermission) ?? []
}

export const isActiveMember = async (tx: Transaction, workspaceId: WorkspaceId, userId: MemberId) =>
  (await tx.run(activeMember(userId)(zql.memberships.where('workspaceId', workspaceId)).one())) !== undefined

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
      .where('deletedAt', 'IS', null)
      .whereExists('memberships', (membership) => membership.where('userId', ctx.userId).where('removedAt', 'IS', null))
      .orderBy('createdAt', 'asc'),
  ),
  memberships: defineQuery(({ ctx }) => zql.memberships.where('workspaceId', ctx.workspaceId)),
  workspaceRoles: defineQuery(({ ctx }) => zql.workspaceRoles.where('workspaceId', ctx.workspaceId)),
  workspaceRolePermissions: defineQuery(({ ctx }) =>
    zql.workspaceRolePermissions.where('workspaceId', ctx.workspaceId),
  ),
  invitations: defineQuery(({ ctx }) =>
    zql.invitations
      .where('workspaceId', ctx.workspaceId)
      .where('revokedAt', 'IS', null)
      .where('acceptedAt', 'IS', null)
      .whereExists('memberships', activeMemberWith(ctx.userId, 'members.invite'))
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
  latestMessages: defineQuery(({ ctx }) =>
    readableBy(ctx.userId)(zql.chats.where('workspaceId', ctx.workspaceId)).related('messages', (message) =>
      message
        .where('kind', 'IN', ['member', 'agent'])
        .where('deletedAt', 'IS', null)
        .where('threadRootId', 'IS', null)
        .where(({ or, cmp }) => or(cmp('authorId', 'IS', null), cmp('authorId', '!=', ctx.userId)))
        .orderBy('seq', 'desc')
        .limit(1),
    ),
  ),
  latestAgentActivity: defineQuery(({ ctx }) =>
    readableBy(ctx.userId)(zql.chats.where('workspaceId', ctx.workspaceId).where('type', 'runtime')).related(
      'messages',
      (message) =>
        message
          .where('kind', 'IN', ['agent', 'step', 'notice'])
          .where('authorId', 'IS', null)
          .orderBy('seq', 'desc')
          .limit(1),
    ),
  ),
  chatMessages: defineQuery(z.object({ chatId: id, limit: z.number() }), ({ ctx, args }) =>
    messagesOf(ctx, args.chatId)
      .where('threadRootId', 'IS', null)
      .where(({ or, cmp }) => or(cmp('replyToId', 'IS', null), cmp('kind', 'member')))
      .orderBy('seq', 'desc')
      .limit(args.limit)
      .related('replies')
      .related('threadReplies'),
  ),
  searchMessages: defineQuery(z.object({ text: searchText }), ({ ctx, args }) =>
    zql.messages
      .where('workspaceId', ctx.workspaceId)
      .where('kind', 'IN', ['member', 'agent'])
      .where('deletedAt', 'IS', null)
      .where(({ or, cmp }) =>
        or(...caseVariantsOf(args.text).map((variant) => cmp('body', 'ILIKE', `%${likeEscaped(variant)}%`))),
      )
      .whereExists('chat', readableBy(ctx.userId))
      .orderBy('createdAt', 'desc')
      .limit(searchResultLimit),
  ),
  chatPinnedSteps: defineQuery(z.object({ chatId: id }), ({ ctx, args }) =>
    messagesOf(ctx, args.chatId).where('kind', 'step').where('body', 'IN', pinnedStepTypes),
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
          exists('memberships', activeMemberWith(ctx.userId, 'tools.manage')),
        ),
      ),
  ),
  toolConnections: defineQuery(({ ctx }) =>
    zql.toolConnections
      .where('workspaceId', ctx.workspaceId)
      .where(({ or, cmp, exists }) => or(cmp('userId', ctx.userId), exists('ownedChats', readableBy(ctx.userId))))
      .orderBy('position', 'asc'),
  ),
  chatBrowserPages: defineQuery(z.object({ chatId: id }), ({ ctx, args }) =>
    zql.browserPages
      .where('workspaceId', ctx.workspaceId)
      .where('chatId', args.chatId)
      .whereExists('chat', readableBy(ctx.userId)),
  ),
  sources: defineQuery(({ ctx }) =>
    zql.sources.where('workspaceId', ctx.workspaceId).whereExists('chat', readableBy(ctx.userId)),
  ),
  chatUsage: defineQuery(z.object({ chatId: id }), ({ ctx, args }) =>
    zql.usageEntries
      .where('workspaceId', ctx.workspaceId)
      .where('chatId', args.chatId)
      .whereExists('chat', readableBy(ctx.userId)),
  ),
  monthUsage: defineQuery(z.object({ month: id }), ({ ctx, args }) =>
    zql.usageEntries
      .where('workspaceId', ctx.workspaceId)
      .where('month', args.month)
      .whereExists('chat', readableBy(ctx.userId)),
  ),
  budgetAlerts: defineQuery(({ ctx }) =>
    zql.budgetAlerts
      .where('workspaceId', ctx.workspaceId)
      .where(({ or, cmp, exists }) =>
        or(cmp('memberId', ctx.userId), exists('memberships', activeMemberWith(ctx.userId, 'budgets.manage'))),
      ),
  ),
  runtimeHosts: defineQuery(({ ctx }) =>
    zql.runtimeHosts
      .where('workspaceId', ctx.workspaceId)
      .where(({ or, and, cmp, exists }) =>
        or(
          cmp('ownerId', ctx.userId),
          and(cmp('ownerId', 'IS', null), exists('memberships', activeMemberWith(ctx.userId, 'runtimes.manage'))),
        ),
      )
      .where('removedAt', 'IS', null)
      .orderBy('createdAt', 'asc'),
  ),
  runtimes: defineQuery(({ ctx }) =>
    zql.runtimes.where('workspaceId', ctx.workspaceId).whereExists('chat', readableBy(ctx.userId)),
  ),
})

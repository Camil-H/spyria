import type { MemberId, WorkspaceId } from '@hq/kernel'
import { createBuilder, defineQueries, defineQuery } from '@rocicorp/zero'
import { schema } from './zero.ts'

export type ZeroContext = {
  userId: MemberId
  workspaceId: WorkspaceId
  role: 'admin' | 'member'
  hqAgentImage?: string
}

export const zql = createBuilder(schema)

declare module '@rocicorp/zero' {
  interface DefaultTypes {
    context: ZeroContext
  }
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
  chats: defineQuery(({ ctx }) => zql.chats.where('workspaceId', ctx.workspaceId).orderBy('createdAt', 'asc')),
  chatParticipants: defineQuery(({ ctx }) => zql.chatParticipants.where('workspaceId', ctx.workspaceId)),
  messages: defineQuery(({ ctx }) =>
    zql.messages.where('workspaceId', ctx.workspaceId).orderBy('chatId', 'asc').orderBy('seq', 'asc'),
  ),
  readMarkers: defineQuery(({ ctx }) =>
    zql.readMarkers.where('workspaceId', ctx.workspaceId).where('userId', ctx.userId),
  ),
  llmCredentials: defineQuery(({ ctx }) =>
    zql.llmCredentials.where('workspaceId', ctx.workspaceId).where('userId', ctx.userId),
  ),
  workspaceConnections: defineQuery(({ ctx }) =>
    zql.workspaceConnections
      .where('workspaceId', ctx.workspaceId)
      .where(({ or, cmp, exists }) => or(cmp('userId', ctx.userId), exists('ownedChats')))
      .orderBy('position', 'asc'),
  ),
  toolConnections: defineQuery(({ ctx }) =>
    zql.toolConnections
      .where('workspaceId', ctx.workspaceId)
      .where(({ or, cmp, exists }) => or(cmp('userId', ctx.userId), exists('ownedChats')))
      .orderBy('position', 'asc'),
  ),
  files: defineQuery(({ ctx }) => zql.files.where('workspaceId', ctx.workspaceId)),
  changes: defineQuery(({ ctx }) => zql.changes.where('workspaceId', ctx.workspaceId)),
  terminalLines: defineQuery(({ ctx }) => zql.terminalLines.where('workspaceId', ctx.workspaceId)),
  planSteps: defineQuery(({ ctx }) => zql.planSteps.where('workspaceId', ctx.workspaceId)),
  commits: defineQuery(({ ctx }) => zql.commits.where('workspaceId', ctx.workspaceId)),
  browserPages: defineQuery(({ ctx }) => zql.browserPages.where('workspaceId', ctx.workspaceId)),
  sources: defineQuery(({ ctx }) => zql.sources.where('workspaceId', ctx.workspaceId)),
  usageEntries: defineQuery(({ ctx }) => zql.usageEntries.where('workspaceId', ctx.workspaceId)),
  runtimeHosts: defineQuery(({ ctx }) =>
    zql.runtimeHosts
      .where('workspaceId', ctx.workspaceId)
      .where(({ or, and, cmp, cmpLit }) =>
        or(cmp('ownerId', ctx.userId), and(cmpLit(ctx.role, '=', 'admin'), cmp('ownerId', 'IS', null))),
      )
      .where('removedAt', 'IS', null)
      .orderBy('createdAt', 'asc'),
  ),
  runtimes: defineQuery(({ ctx }) => zql.runtimes.where('workspaceId', ctx.workspaceId)),
})

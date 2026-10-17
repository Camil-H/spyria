import type { Snapshot } from '@hq/db'
import type { MemberId, WorkspaceId } from '@hq/kernel'

export const isWorkspaceAdmin = (workspaceId: WorkspaceId, memberId: MemberId) => (snapshot: Snapshot) =>
  snapshot.memberships.some(
    (membership) =>
      membership.workspaceId === workspaceId &&
      membership.memberId === memberId &&
      membership.role === 'admin' &&
      membership.removedAt === null,
  )

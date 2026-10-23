import type { Snapshot } from '@spyria/db'
import { adminRoleId, type MemberId, type WorkspaceId } from '@spyria/kernel'

export const getDeletableWorkspace = (workspaceId: WorkspaceId, memberId: MemberId) => (snapshot: Snapshot) => {
  const isAdmin = snapshot.memberships.some(
    (membership) =>
      membership.workspaceId === workspaceId &&
      membership.memberId === memberId &&
      membership.removedAt === null &&
      membership.role === adminRoleId,
  )
  return isAdmin ? snapshot.workspaces.find((workspace) => workspace.id === workspaceId) : undefined
}

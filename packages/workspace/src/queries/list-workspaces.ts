import type { Snapshot } from '@spyria/db'
import type { MemberId, WorkspaceId } from '@spyria/kernel'

export const listWorkspaces = (memberId: MemberId) => (snapshot: Snapshot) => {
  const workspaceIds = new Set<WorkspaceId>()
  for (const membership of snapshot.memberships)
    if (membership.memberId === memberId && membership.removedAt === null) workspaceIds.add(membership.workspaceId)
  return snapshot.workspaces.filter((workspace) => workspaceIds.has(workspace.id))
}

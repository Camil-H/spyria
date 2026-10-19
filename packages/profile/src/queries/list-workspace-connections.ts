import { memberToolsIn, type Snapshot, workspaceConnectionsIn } from '@spyria/db'
import type { WorkspaceId } from '@spyria/kernel'

export const listWorkspaceConnections = (workspaceId: WorkspaceId) => (snapshot: Snapshot) => {
  const members = snapshot.memberships
    .filter((membership) => membership.workspaceId === workspaceId && membership.removedAt === null)
    .toSorted((first, second) => first.displayName.localeCompare(second.displayName))
  return workspaceConnectionsIn(snapshot, workspaceId).map((connection) => ({
    ...connection,
    members: members.map(({ memberId, displayName }) => ({
      id: memberId,
      name: displayName,
      tools: memberToolsIn(snapshot, connection, memberId),
    })),
  }))
}

export type ListedWorkspaceConnection = ReturnType<ReturnType<typeof listWorkspaceConnections>>[number]

import { connectionAccessIn, type Snapshot, workspaceConnectionsIn } from '@spyria/db'
import type { WorkspaceId } from '@spyria/kernel'

export const listWorkspaceConnections = (workspaceId: WorkspaceId) => (snapshot: Snapshot) => {
  const members = snapshot.memberships
    .filter((membership) => membership.workspaceId === workspaceId && membership.removedAt === null)
    .toSorted((first, second) => first.displayName.localeCompare(second.displayName))
  const roles = snapshot.workspaceRoles.filter((role) => role.workspaceId === workspaceId)
  const accessRows = connectionAccessIn(snapshot, workspaceId)
  return workspaceConnectionsIn(snapshot, workspaceId).map((connection) => {
    const ofServer = accessRows.filter((access) => access.connectionId === connection.id)
    const accessOfMember = (memberId: string) => ofServer.find((access) => access.memberId === memberId)
    return {
      ...connection,
      roles: roles.map(({ id, name }) => ({
        id,
        name,
        access: ofServer.find((access) => access.roleId === id),
      })),
      namedMembers: members.flatMap(({ memberId, displayName }) => {
        const access = accessOfMember(memberId)
        return access ? [{ id: memberId, name: displayName, access }] : []
      }),
      otherMembers: members
        .filter(({ memberId }) => !accessOfMember(memberId))
        .map(({ memberId, displayName }) => ({ id: memberId, name: displayName })),
    }
  })
}

export type ListedWorkspaceConnection = ReturnType<ReturnType<typeof listWorkspaceConnections>>[number]

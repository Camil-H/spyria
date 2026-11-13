import { connectionAccessIn, type Snapshot, workspaceConnectionsIn } from '@spyria/db'
import {
  githubConnectionId,
  githubRoleAccessOf,
  githubServerName,
  githubTools,
  type ToolServerAccess,
  type WorkspaceId,
} from '@spyria/kernel'

const accessListOf = (snapshot: Snapshot, workspaceId: WorkspaceId) => {
  const members = snapshot.memberships
    .filter((membership) => membership.workspaceId === workspaceId && membership.removedAt === null)
    .toSorted((first, second) => first.displayName.localeCompare(second.displayName))
  const roles = snapshot.workspaceRoles.filter((role) => role.workspaceId === workspaceId)
  const accessRowsByConnection = Map.groupBy(connectionAccessIn(snapshot, workspaceId), (access) => access.connectionId)
  return (
    connectionId: string,
    roleAccessOf: (roleId: string, ofServer: ToolServerAccess[]) => ToolServerAccess | undefined,
  ) => {
    const ofServer = accessRowsByConnection.get(connectionId) ?? []
    const accessByMember = new Map(ofServer.flatMap((access) => (access.memberId ? [[access.memberId, access]] : [])))
    return {
      roles: roles.map(({ id, name }) => ({ id, name, access: roleAccessOf(id, ofServer) })),
      namedMembers: members.flatMap(({ memberId, displayName }) => {
        const access = accessByMember.get(memberId)
        return access ? [{ id: memberId, name: displayName, access }] : []
      }),
      otherMembers: members
        .filter(({ memberId }) => !accessByMember.has(memberId))
        .map(({ memberId, displayName }) => ({ id: memberId, name: displayName })),
    }
  }
}

export const listWorkspaceConnections = (workspaceId: WorkspaceId) => (snapshot: Snapshot) => {
  const accessListFor = accessListOf(snapshot, workspaceId)
  return workspaceConnectionsIn(snapshot, workspaceId).map((connection) => ({
    ...connection,
    ...accessListFor(connection.id, (roleId, ofServer) => ofServer.find((access) => access.roleId === roleId)),
  }))
}

export const listGitHubToolAccess = (workspaceId: WorkspaceId) => (snapshot: Snapshot) => ({
  id: githubConnectionId,
  name: githubServerName,
  tools: githubTools,
  ...accessListOf(snapshot, workspaceId)(githubConnectionId, githubRoleAccessOf),
})

export type ListedWorkspaceConnection = ReturnType<ReturnType<typeof listWorkspaceConnections>>[number]
export type ServerAccessList = Pick<
  ListedWorkspaceConnection,
  'id' | 'name' | 'tools' | 'roles' | 'namedMembers' | 'otherMembers'
>

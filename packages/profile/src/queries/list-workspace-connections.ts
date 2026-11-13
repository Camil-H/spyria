import { connectionAccessIn, type Snapshot, workspaceConnectionsIn } from '@spyria/db'
import {
  githubConnectionId,
  githubRoleAccessOf,
  githubServerName,
  githubTools,
  type ToolServerAccess,
  type WorkspaceId,
} from '@spyria/kernel'

export const listToolRoles = (workspaceId: WorkspaceId) => (snapshot: Snapshot) =>
  snapshot.workspaceRoles.filter((role) => role.workspaceId === workspaceId).map(({ id, name }) => ({ id, name }))

const accessListOf = (snapshot: Snapshot, workspaceId: WorkspaceId) => {
  const roles = listToolRoles(workspaceId)(snapshot)
  const accessRowsByConnection = Map.groupBy(connectionAccessIn(snapshot, workspaceId), (access) => access.connectionId)
  return (
    connectionId: string,
    roleAccessOf: (roleId: string, ofServer: ToolServerAccess[]) => ToolServerAccess | undefined,
  ) => {
    const ofServer = accessRowsByConnection.get(connectionId) ?? []
    return { roles: roles.map(({ id, name }) => ({ id, name, access: roleAccessOf(id, ofServer) })) }
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
export type ServerAccessList = Pick<ListedWorkspaceConnection, 'id' | 'name' | 'tools' | 'roles'>

import { connectionAccessIn, ownedBy, type Snapshot, usableConnectionsIn } from '@spyria/db'
import {
  githubConnectionId,
  githubServerName,
  githubTools,
  githubToolsOf,
  type MemberId,
  type WorkspaceId,
} from '@spyria/kernel'
import { connectionStatuses } from '../domain/tool-connection.ts'
import { connectionSignIns } from '../domain/workspace-connection.ts'

export const getToolConnections = (workspaceId: WorkspaceId, memberId: MemberId) => (snapshot: Snapshot) =>
  usableConnectionsIn(snapshot, workspaceId, memberId)

export const getGitHubApprovals = (workspaceId: WorkspaceId, memberId: MemberId) => (snapshot: Snapshot) => {
  const membership = snapshot.memberships.find(
    (row) => row.workspaceId === workspaceId && row.memberId === memberId && row.removedAt === null,
  )
  if (!membership) return undefined
  const granted = githubToolsOf(connectionAccessIn(snapshot, workspaceId), { memberId, roleId: membership.role })
  return {
    id: githubConnectionId,
    name: githubServerName,
    signIn: connectionSignIns.member,
    tools: githubTools.filter((tool) => granted.includes(tool.name)),
    approvals: snapshot.toolApprovals.find(
      (row) => ownedBy(workspaceId, memberId)(row) && row.connectionId === githubConnectionId,
    ),
  }
}

export const countConnectionStates = (workspaceId: WorkspaceId, memberId: MemberId) => (snapshot: Snapshot) => {
  const statuses = [
    snapshot.githubConnections.some(ownedBy(workspaceId, memberId)) ? connectionStatuses.connected : undefined,
    ...usableConnectionsIn(snapshot, workspaceId, memberId).map(({ status }) => status),
  ]
  return {
    connected: statuses.filter((status) => status === connectionStatuses.connected).length,
    toReconnect: statuses.filter((status) => status === connectionStatuses.needsReconnection).length,
  }
}

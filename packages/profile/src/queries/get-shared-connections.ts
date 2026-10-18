import { memberToolsIn, type Snapshot, workspaceConnectionsIn } from '@hq/db'
import type { MemberId, WorkspaceId } from '@hq/kernel'

export const getSharedConnections = (workspaceId: WorkspaceId, memberId: MemberId) => (snapshot: Snapshot) =>
  workspaceConnectionsIn(snapshot, workspaceId).map((connection) => ({
    id: connection.id,
    name: connection.name,
    tools: memberToolsIn(snapshot, connection, memberId),
  }))

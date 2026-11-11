import { type Snapshot, usableConnectionsIn } from '@spyria/db'
import type { MemberId, WorkspaceId } from '@spyria/kernel'

export const getToolConnections = (workspaceId: WorkspaceId, memberId: MemberId) => (snapshot: Snapshot) =>
  usableConnectionsIn(snapshot, workspaceId, memberId)

import { ownedBy, type Snapshot } from '@hq/db'
import type { MemberId, WorkspaceId } from '@hq/kernel'

export const getSharedConnections = (workspaceId: WorkspaceId, memberId: MemberId) => (snapshot: Snapshot) =>
  snapshot.workspaceConnections.filter(ownedBy(workspaceId, memberId)).map(({ tool, access }) => ({ tool, access }))

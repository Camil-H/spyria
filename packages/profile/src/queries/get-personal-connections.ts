import { ownedBy, type Snapshot } from '@hq/db'
import type { MemberId, WorkspaceId } from '@hq/kernel'

export const getPersonalConnections = (workspaceId: WorkspaceId, memberId: MemberId) => (snapshot: Snapshot) =>
  snapshot.toolConnections.filter(ownedBy(workspaceId, memberId)).map(({ tool, status }) => ({ tool, status }))

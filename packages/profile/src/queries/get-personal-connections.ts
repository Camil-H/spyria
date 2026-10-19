import { ownedBy, type Snapshot } from '@spyria/db'
import type { MemberId, WorkspaceId } from '@spyria/kernel'

export const getPersonalConnections = (workspaceId: WorkspaceId, memberId: MemberId) => (snapshot: Snapshot) =>
  snapshot.toolConnections.filter(ownedBy(workspaceId, memberId)).map(({ tool, status }) => ({ tool, status }))

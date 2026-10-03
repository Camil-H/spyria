import { ownedBy, type Snapshot } from '@hq/db'
import type { MemberId, WorkspaceId } from '@hq/kernel'

export const getPersonalConnections = (workspaceId: WorkspaceId, memberId: MemberId) => (snapshot: Snapshot) => {
  const connected = snapshot.toolConnections
    .filter(ownedBy(workspaceId, memberId))
    .map(({ tool, status }) => ({ tool, status }))
  const connectedTools = new Set(connected.map(({ tool }) => tool))
  return { connected, available: snapshot.toolCatalog.filter((tool) => !connectedTools.has(tool)) }
}

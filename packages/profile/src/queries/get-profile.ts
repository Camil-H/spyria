import { ownedBy, type Snapshot } from '@hq/db'
import type { MemberId, WorkspaceId } from '@hq/kernel'

export const getProfile = (workspaceId: WorkspaceId, memberId: MemberId) => (snapshot: Snapshot) =>
  snapshot.memberships.find(ownedBy(workspaceId, memberId))?.displayName

import { ownedBy, type Snapshot } from '@spyria/db'
import type { MemberId, WorkspaceId } from '@spyria/kernel'

export const getProfile = (workspaceId: WorkspaceId, memberId: MemberId) => (snapshot: Snapshot) =>
  snapshot.memberships.find(ownedBy(workspaceId, memberId))?.displayName

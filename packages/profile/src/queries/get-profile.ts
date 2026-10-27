import { ownedBy, type Snapshot } from '@spyria/db'
import type { MemberId, WorkspaceId } from '@spyria/kernel'

export const getProfile = (workspaceId: WorkspaceId, memberId: MemberId) => (snapshot: Snapshot) => {
  const membership = snapshot.memberships.find(ownedBy(workspaceId, memberId))
  return membership && { displayName: membership.displayName, avatar: membership.avatar }
}

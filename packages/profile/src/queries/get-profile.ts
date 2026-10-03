import type { Snapshot } from '@hq/db'
import type { MemberId, WorkspaceId } from '@hq/kernel'

export const getProfile = (workspaceId: WorkspaceId, memberId: MemberId) => (snapshot: Snapshot) => {
  const isMember = snapshot.memberships.some(
    (membership) => membership.workspaceId === workspaceId && membership.memberId === memberId,
  )
  const member = snapshot.members.find((candidate) => candidate.id === memberId)
  return isMember && member ? { name: member.name } : null
}

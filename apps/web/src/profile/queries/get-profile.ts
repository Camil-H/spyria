import type { Snapshot } from '@hq/db'
import type { MemberId } from '@hq/kernel'

export const getProfile = (memberId: MemberId) => (snapshot: Snapshot) => {
  const member = snapshot.members.find((candidate) => candidate.id === memberId)
  return member ? { id: member.id, name: member.name } : null
}

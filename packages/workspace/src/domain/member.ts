import { adminRoleId, type MemberId, type WorkspaceId } from '@hq/kernel'
import { LastAdmin, MemberNotFound, OwnMembership } from './errors.ts'

export type Member = Readonly<{
  workspaceId: WorkspaceId
  id: MemberId
  role: string
  removedAt: number | null
}>

export const workspaceJobTypes = { memberRemoved: 'workspace.member-removed' } as const

export const isActive = (member: Member | undefined): member is Member =>
  member !== undefined && member.removedAt === null

export const requireActiveMember = (member: Member | undefined, memberId: MemberId) => {
  if (!isActive(member)) throw new MemberNotFound(memberId)
  return member
}

export const requireAnotherMember = (memberId: MemberId, actorId: MemberId) => {
  if (memberId === actorId) throw new OwnMembership()
}

export const requireAnotherAdmin = (member: Member, activeAdminIds: readonly MemberId[]) => {
  if (member.role === adminRoleId && activeAdminIds.every((adminId) => adminId === member.id)) throw new LastAdmin()
}

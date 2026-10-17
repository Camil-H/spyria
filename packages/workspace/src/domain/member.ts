import type { MemberId, WorkspaceId } from '@hq/kernel'
import { LastAdmin, MemberNotFound, NotWorkspaceAdmin } from './errors.ts'

export type WorkspaceRole = 'admin' | 'member'

export type Member = Readonly<{
  workspaceId: WorkspaceId
  id: MemberId
  role: WorkspaceRole
  removedAt: number | null
}>

export const workspaceJobTypes = { memberRemoved: 'workspace.member-removed' } as const

export const isActive = (member: Member | undefined): member is Member =>
  member !== undefined && member.removedAt === null

export const requireAdmin = (actor: Member | undefined) => {
  if (!isActive(actor) || actor.role !== 'admin') throw new NotWorkspaceAdmin()
}

export const requireActiveMember = (member: Member | undefined, memberId: MemberId) => {
  if (!isActive(member)) throw new MemberNotFound(memberId)
  return member
}

export const requireAnotherAdmin = (member: Member, activeAdminIds: readonly MemberId[]) => {
  if (member.role === 'admin' && activeAdminIds.every((adminId) => adminId === member.id)) throw new LastAdmin()
}

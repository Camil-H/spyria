import type { Snapshot } from '@hq/db'
import type { MemberId, WorkspaceId } from '@hq/kernel'
import { isLastAdmin, type WorkspaceRole } from '../domain/member.ts'

export type WorkspaceMember = Readonly<{
  id: MemberId
  name: string
  email: string
  role: WorkspaceRole
  isLastAdmin: boolean
}>

export const listMembers =
  (workspaceId: WorkspaceId) =>
  (snapshot: Snapshot): readonly WorkspaceMember[] => {
    const activeMemberships = snapshot.memberships.filter(
      (membership) => membership.workspaceId === workspaceId && membership.removedAt === null,
    )
    const activeAdminIds = activeMemberships.flatMap((membership) =>
      membership.role === 'admin' ? [membership.memberId] : [],
    )
    return activeMemberships
      .map((membership) => ({
        id: membership.memberId,
        name: membership.displayName,
        email: membership.email,
        role: membership.role,
        isLastAdmin: isLastAdmin({ id: membership.memberId, role: membership.role }, activeAdminIds),
      }))
      .toSorted((first, second) => first.name.localeCompare(second.name))
  }

export const listInvitations = (workspaceId: WorkspaceId) => (snapshot: Snapshot) =>
  snapshot.invitations.filter((invitation) => invitation.workspaceId === workspaceId)

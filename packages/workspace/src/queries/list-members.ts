import type { Snapshot } from '@spyria/db'
import type { MemberId, WorkspaceId } from '@spyria/kernel'

export type WorkspaceMember = Readonly<{
  id: MemberId
  name: string
  email: string
  role: string
}>

export const listMembers =
  (workspaceId: WorkspaceId) =>
  (snapshot: Snapshot): readonly WorkspaceMember[] => {
    const activeMemberships = snapshot.memberships.filter(
      (membership) => membership.workspaceId === workspaceId && membership.removedAt === null,
    )
    return activeMemberships
      .map((membership) => ({
        id: membership.memberId,
        name: membership.displayName,
        email: membership.email,
        role: membership.role,
      }))
      .toSorted((first, second) => first.name.localeCompare(second.name))
  }

export const listInvitations = (workspaceId: WorkspaceId) => (snapshot: Snapshot) =>
  snapshot.invitations.filter((invitation) => invitation.workspaceId === workspaceId)

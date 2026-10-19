import { type MemberId, requireWorkspacePermission } from '@hq/kernel'
import type { WorkspaceTransactor } from '../contracts/transactor.ts'
import { requireActiveMember, requireAnotherAdmin, requireAnotherMember } from '../domain/member.ts'
import { requireGrantableRole } from '../domain/role.ts'

type Dependencies = { transactor: WorkspaceTransactor }
type Input = { memberId: MemberId; actorId: MemberId; now: number }

export const removeMember = ({ transactor }: Dependencies, { memberId, actorId, now }: Input) =>
  transactor.run(async ({ memberships, workspaceRoles, memberAccess, chats, chatRuntimes, workspaceEvents }) => {
    const actorPermissions = await requireWorkspacePermission(memberships, actorId, 'members.manage')
    requireAnotherMember(memberId, actorId)
    const member = requireActiveMember(await memberships.get(memberId), memberId)
    requireGrantableRole(actorPermissions, await workspaceRoles.get(member.role), member.role)
    requireAnotherAdmin(member, await memberships.activeAdminIds())
    await memberships.save({ ...member, removedAt: now })
    await memberAccess.revoke(memberId)
    for (const chat of await chats.participatedBy(memberId))
      if (chat.ownerId === memberId) await chatRuntimes.stop(chat.id)
      else await chats.removeParticipant({ chatId: chat.id, memberId, actorId })
    await memberAccess.stopTurnsLater({ memberId, actorId })
    await workspaceEvents.record({ type: 'member.removed', actorId, payload: { memberId } })
  })

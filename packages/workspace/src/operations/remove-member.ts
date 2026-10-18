import type { MemberId } from '@hq/kernel'
import type { WorkspaceTransactor } from '../contracts/transactor.ts'
import { requireActiveMember, requireAdmin, requireAnotherAdmin, requireAnotherMember } from '../domain/member.ts'

type Dependencies = { transactor: WorkspaceTransactor }
type Input = { memberId: MemberId; actorId: MemberId; now: number }

export const removeMember = ({ transactor }: Dependencies, { memberId, actorId, now }: Input) =>
  transactor.run(async ({ memberships, memberAccess, chats, chatRuntimes, workspaceEvents }) => {
    requireAdmin(await memberships.get(actorId))
    requireAnotherMember(memberId, actorId)
    const member = requireActiveMember(await memberships.get(memberId), memberId)
    requireAnotherAdmin(member, await memberships.activeAdminIds())
    await memberships.save({ ...member, removedAt: now })
    await memberAccess.revoke(memberId)
    for (const chat of await chats.participatedBy(memberId))
      if (chat.ownerId === memberId) await chatRuntimes.stop(chat.id)
      else await chats.removeParticipant({ chatId: chat.id, memberId, actorId })
    await memberAccess.stopTurnsLater({ memberId, actorId })
    await workspaceEvents.record({ type: 'member.removed', actorId, payload: { memberId } })
  })

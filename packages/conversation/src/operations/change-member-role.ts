import { type ChatId, type MemberId, requireChatPermission } from '@hq/kernel'
import type { ConversationTransactor } from '../contracts/transactor.ts'
import { requireAssignableRole } from './invite-member.ts'
import { requireNonOwnerParticipant } from './remove-member.ts'

type Dependencies = { transactor: ConversationTransactor }
type Input = { chatId: ChatId; memberId: MemberId; roleId: string; actorId: MemberId }

export const changeMemberRole = ({ transactor }: Dependencies, { chatId, memberId, roleId, actorId }: Input) =>
  transactor.run(async (unitOfWork) => {
    await requireChatPermission(unitOfWork.chats, chatId, actorId, 'members.manage')
    await requireNonOwnerParticipant(unitOfWork, chatId, memberId)
    await requireAssignableRole(unitOfWork, chatId, actorId, roleId)
    await unitOfWork.chats.changeParticipant({ type: 'member.role_changed', chatId, memberId, roleId, actorId })
  })

import type { ChatId, MemberId } from '@hq/kernel'
import type { ConversationTransactor } from '../contracts/transactor.ts'
import { requireNonOwnerParticipant } from './remove-member.ts'

type Dependencies = { transactor: ConversationTransactor }
type Input = { chatId: ChatId; memberId: MemberId }

export const leaveChat = ({ transactor }: Dependencies, { chatId, memberId }: Input) =>
  transactor.run(async (unitOfWork) => {
    await requireNonOwnerParticipant(unitOfWork, chatId, memberId)
    await unitOfWork.chats.changeParticipant({ type: 'member.left', chatId, memberId, roleId: null, actorId: memberId })
  })

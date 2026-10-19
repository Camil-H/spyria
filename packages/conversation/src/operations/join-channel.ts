import { type ChatId, type MemberId, requireChatPermission } from '@spyria/kernel'
import type { ConversationTransactor } from '../contracts/transactor.ts'
import { AlreadyParticipant } from '../domain/errors.ts'

type Dependencies = { transactor: ConversationTransactor }
type Input = { chatId: ChatId; memberId: MemberId }

export const joinChannel = ({ transactor }: Dependencies, { chatId, memberId }: Input) =>
  transactor.run(async (unitOfWork) => {
    await requireChatPermission(unitOfWork.chats, chatId, memberId, 'chat.read')
    if (await unitOfWork.chats.roleOf(chatId, memberId)) throw new AlreadyParticipant()
    await unitOfWork.chats.join(chatId, memberId)
  })

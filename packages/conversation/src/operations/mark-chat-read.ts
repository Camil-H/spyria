import { type ChatId, type MemberId, requireChatPermission } from '@spyria/kernel'
import type { ConversationTransactor } from '../contracts/transactor.ts'

type Dependencies = { transactor: ConversationTransactor }
type Input = { chatId: ChatId; memberId: MemberId }

export const markChatRead = ({ transactor }: Dependencies, { chatId, memberId }: Input) =>
  transactor.run(async (unitOfWork) => {
    await requireChatPermission(unitOfWork.chats, chatId, memberId, 'chat.read')
    await unitOfWork.readMarkers.markNewestRead(chatId, memberId)
  })

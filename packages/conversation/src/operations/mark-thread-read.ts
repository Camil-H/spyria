import { type ChatId, type MemberId, type MessageId, requireChatPermission } from '@hq/kernel'
import type { ConversationTransactor } from '../contracts/transactor.ts'

type Dependencies = { transactor: ConversationTransactor }
type Input = { chatId: ChatId; threadRootId: MessageId; memberId: MemberId }

export const markThreadRead = ({ transactor }: Dependencies, { chatId, threadRootId, memberId }: Input) =>
  transactor.run(async (unitOfWork) => {
    await requireChatPermission(unitOfWork.chats, chatId, memberId, 'chat.read')
    await unitOfWork.readMarkers.markThreadRead(chatId, threadRootId, memberId)
  })

import { type MemberId, type MessageId, requireChatPermission } from '@spyria/kernel'
import type { ConversationTransactor } from '../contracts/transactor.ts'
import { deletedMessage } from '../domain/message.ts'

type Dependencies = { transactor: ConversationTransactor }
type Input = { messageId: MessageId; deleterId: MemberId }

export const deleteMessage = ({ transactor }: Dependencies, { messageId, deleterId }: Input) =>
  transactor.run(async (unitOfWork) => {
    const message = await unitOfWork.messages.get(messageId)
    await requireChatPermission(unitOfWork.chats, message.chatId, deleterId, 'chat.post')
    await unitOfWork.messages.record({
      type: 'message.deleted',
      actorId: deleterId,
      message: deletedMessage(message, deleterId, new Date()),
    })
  })

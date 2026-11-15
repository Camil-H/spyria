import { type MemberId, type MessageId, memberActor, requireChatPermission } from '@spyria/kernel'
import type { ConversationTransactor } from '../contracts/transactor.ts'
import { deletedMessage } from '../domain/message.ts'
import { requireQueuedIfPrompt } from './queued-prompts.ts'

type Dependencies = { transactor: ConversationTransactor }
type Input = { messageId: MessageId; deleterId: MemberId }

export const deleteMessage = ({ transactor }: Dependencies, { messageId, deleterId }: Input) =>
  transactor.run(async (unitOfWork) => {
    const message = await unitOfWork.messages.lock(messageId)
    await requireChatPermission(unitOfWork.chats, message.chatId, deleterId, 'chat.post')
    const deleted = deletedMessage(message, deleterId, new Date())
    await requireQueuedIfPrompt(unitOfWork, message)
    await unitOfWork.messages.record({ type: 'message.deleted', actor: memberActor(deleterId), message: deleted })
    await unitOfWork.attachments.discard(messageId)
  })

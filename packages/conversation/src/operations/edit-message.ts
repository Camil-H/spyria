import { type MemberId, type MessageId, memberActor, requireChatPermission } from '@spyria/kernel'
import type { ConversationTransactor } from '../contracts/transactor.ts'
import { editedMessage } from '../domain/message.ts'
import { MessageBody } from '../domain/message-body.ts'
import { requireQueuedIfPrompt } from './queued-prompts.ts'

type Dependencies = { transactor: ConversationTransactor }
type Input = { messageId: MessageId; editorId: MemberId; text: string }

export const editMessage = ({ transactor }: Dependencies, { messageId, editorId, text }: Input) =>
  transactor.run(async (unitOfWork) => {
    const message = await unitOfWork.messages.lock(messageId)
    await requireChatPermission(unitOfWork.chats, message.chatId, editorId, 'chat.post')
    const edited = editedMessage(
      message,
      editorId,
      MessageBody(text, { allowsBlank: message.attachments.length > 0 }),
      new Date(),
    )
    await requireQueuedIfPrompt(unitOfWork, message)
    await unitOfWork.messages.record({ type: 'message.edited', actor: memberActor(editorId), message: edited })
  })

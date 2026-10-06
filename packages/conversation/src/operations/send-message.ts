import { type ChatId, type MemberId, messageId } from '@hq/kernel'
import type { ConversationTransactor } from '../contracts/transactor.ts'
import { newMessage } from '../domain/message.ts'
import { MessageBody } from '../domain/message-body.ts'

type Dependencies = { transactor: ConversationTransactor }
type Input = { id: string; chatId: ChatId; authorId: MemberId; text: string }

export const sendMessage = ({ transactor }: Dependencies, { id, chatId, authorId, text }: Input) =>
  transactor.run(async (unitOfWork) => {
    const chat = await unitOfWork.chats.get(chatId)
    const message = newMessage({
      id: messageId(id),
      workspaceId: chat.workspaceId,
      chatId,
      kind: 'member',
      authorId,
      body: MessageBody(text),
      createdAt: new Date(),
      replyToId: null,
    })
    await unitOfWork.messages.record({ type: 'message.posted', actorId: authorId, message })
    if (chat.type === 'runtime') await unitOfWork.agentPrompts.request(message)
  })

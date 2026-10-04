import { type ChatId, type IdGenerator, type MemberId, messageId } from '@hq/kernel'
import type { Clock } from '../contracts/clock.ts'
import type { ConversationTransactor } from '../contracts/transactor.ts'
import { newMessage } from '../domain/message.ts'
import { MessageBody } from '../domain/message-body.ts'

type Dependencies = { transactor: ConversationTransactor; idGenerator: IdGenerator; clock: Clock }
type Input = { chatId: ChatId; authorId: MemberId; text: string }

export const sendMessage = ({ transactor, idGenerator, clock }: Dependencies, { chatId, authorId, text }: Input) =>
  transactor.run(async (unitOfWork) => {
    const chat = await unitOfWork.chats.get(chatId)
    const message = newMessage({
      id: messageId(idGenerator.next()),
      workspaceId: chat.workspaceId,
      chatId,
      kind: 'member',
      authorId,
      body: MessageBody(text),
      createdAt: clock.now(),
      replyToId: null,
    })
    await unitOfWork.messages.record({ type: 'message.posted', actorId: authorId, message })
    if (chat.type === 'runtime') await unitOfWork.agentReplies.request(message)
  })

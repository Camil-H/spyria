import { type MessageId, messageId } from '@hq/kernel'
import type { ConversationTransactor } from '../contracts/transactor.ts'
import { newMessage } from '../domain/message.ts'
import { MessageBody } from '../domain/message-body.ts'

type Dependencies = { transactor: ConversationTransactor }
type Input = { id: string; answeredMessageId: MessageId; text: string }

export const appendAgentReply = ({ transactor }: Dependencies, { id, answeredMessageId, text }: Input) =>
  transactor.run(async (unitOfWork) => {
    const answered = await unitOfWork.messages.get(answeredMessageId)
    await unitOfWork.messages.record({
      type: 'message.replied',
      actorId: null,
      message: newMessage({
        id: messageId(id),
        workspaceId: answered.workspaceId,
        chatId: answered.chatId,
        kind: 'agent',
        authorId: null,
        body: MessageBody(text),
        createdAt: new Date(),
        replyToId: answered.id,
      }),
    })
  })

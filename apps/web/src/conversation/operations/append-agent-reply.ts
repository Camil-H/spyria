import { type IdGenerator, type MessageId, messageId as toMessageId } from '@hq/kernel'
import type { Clock } from '../contracts/clock.ts'
import type { ConversationTransactor } from '../contracts/transactor.ts'
import { newMessage } from '../domain/message.ts'
import { MessageBody } from '../domain/message-body.ts'

type Dependencies = { transactor: ConversationTransactor; idGenerator: IdGenerator; clock: Clock }
type Input = { answeredMessageId: MessageId; text: string }

export const appendAgentReply = (
  { transactor, idGenerator, clock }: Dependencies,
  { answeredMessageId, text }: Input,
) =>
  transactor.run(async (unitOfWork) => {
    const answered = await unitOfWork.messages.get(answeredMessageId)
    await unitOfWork.messages.save({ ...answered, needsReply: false })
    await unitOfWork.messages.insertAfter(
      newMessage({
        id: toMessageId(idGenerator.next()),
        workspaceId: answered.workspaceId,
        chatId: answered.chatId,
        kind: 'agent',
        authorId: null,
        body: MessageBody(text),
        createdAt: clock.now(),
        needsReply: false,
      }),
      answered.id,
    )
  })

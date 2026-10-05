import type { MemberId, MessageId } from '@hq/kernel'
import type { ConversationTransactor } from '../contracts/transactor.ts'
import { editedMessage } from '../domain/message.ts'
import { MessageBody } from '../domain/message-body.ts'

type Dependencies = { transactor: ConversationTransactor }
type Input = { messageId: MessageId; editorId: MemberId; text: string }

export const editMessage = ({ transactor }: Dependencies, { messageId, editorId, text }: Input) =>
  transactor.run(async (unitOfWork) => {
    const message = await unitOfWork.messages.get(messageId)
    await unitOfWork.messages.record({
      type: 'message.edited',
      actorId: editorId,
      message: editedMessage(message, editorId, MessageBody(text), new Date()),
    })
  })

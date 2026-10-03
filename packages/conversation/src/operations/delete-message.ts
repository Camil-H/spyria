import type { MemberId, MessageId } from '@hq/kernel'
import type { Clock } from '../contracts/clock.ts'
import type { ConversationTransactor } from '../contracts/transactor.ts'
import { deleteMessage as tombstoneMessage } from '../domain/message.ts'

type Dependencies = { transactor: ConversationTransactor; clock: Clock }
type Input = { messageId: MessageId; deleterId: MemberId }

export const deleteMessage = ({ transactor, clock }: Dependencies, { messageId, deleterId }: Input) =>
  transactor.run(async (unitOfWork) => {
    const message = await unitOfWork.messages.get(messageId)
    await unitOfWork.messages.save(tombstoneMessage(message, deleterId, clock.now()))
  })

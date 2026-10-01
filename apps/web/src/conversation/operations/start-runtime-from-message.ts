import { type MemberId, type MessageId, messageId as toMessageId } from '@hq/kernel'
import type { Clock } from '../contracts/clock.ts'
import type { IdGenerator } from '../contracts/id-generator.ts'
import type { RuntimeChatStarter } from '../contracts/runtime-chat-starter.ts'
import type { ConversationTransactor } from '../contracts/transactor.ts'
import { MessageDeleted } from '../domain/errors.ts'
import { newMessage } from '../domain/message.ts'
import { chatNameFrom } from '../domain/message-body.ts'

type Dependencies = {
  transactor: ConversationTransactor
  idGenerator: IdGenerator
  clock: Clock
  runtimeChatStarter: RuntimeChatStarter
}
type Input = { messageId: MessageId; memberId: MemberId }

export const startRuntimeFromMessage = async (
  { transactor, idGenerator, clock, runtimeChatStarter }: Dependencies,
  { messageId, memberId }: Input,
) => {
  const source = await transactor.run(async (unitOfWork) => {
    const message = await unitOfWork.messages.get(messageId)
    if (message.deletedAt) throw new MessageDeleted()
    return message
  })
  const { chatId } = await runtimeChatStarter.start({
    sourceChatId: source.chatId,
    name: chatNameFrom(source.body),
    ownerId: memberId,
  })
  await transactor.run((unitOfWork) =>
    unitOfWork.messages.add(
      newMessage({
        id: toMessageId(idGenerator.next()),
        workspaceId: source.workspaceId,
        chatId,
        kind: 'member',
        authorId: memberId,
        body: source.body,
        createdAt: clock.now(),
        needsReply: false,
      }),
    ),
  )
  return chatId
}

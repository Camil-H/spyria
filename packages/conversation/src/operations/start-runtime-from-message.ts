import { type ChatId, type MemberId, type MessageId, messageId as toMessageId } from '@hq/kernel'
import type { RuntimeChatStarter } from '../contracts/runtime-chat-starter.ts'
import type { ConversationTransactor } from '../contracts/transactor.ts'
import { MessageDeleted } from '../domain/errors.ts'
import { newMessage } from '../domain/message.ts'
import { chatNameFrom } from '../domain/message-body.ts'

type Dependencies = { transactor: ConversationTransactor; runtimeChatStarter: RuntimeChatStarter }
type Input = { id: string; chatId: ChatId; messageId: MessageId; memberId: MemberId }

export const startRuntimeFromMessage = (
  { transactor, runtimeChatStarter }: Dependencies,
  { id, chatId, messageId, memberId }: Input,
) =>
  transactor.run(async (unitOfWork) => {
    const source = await unitOfWork.messages.get(messageId)
    if (source.deletedAt) throw new MessageDeleted()
    await runtimeChatStarter.start({
      id: chatId,
      sourceChatId: source.chatId,
      name: chatNameFrom(source.body),
      ownerId: memberId,
    })
    await unitOfWork.messages.record({
      type: 'message.posted',
      actorId: memberId,
      message: newMessage({
        id: toMessageId(id),
        workspaceId: source.workspaceId,
        chatId,
        kind: 'member',
        authorId: memberId,
        body: source.body,
        createdAt: new Date(),
        replyToId: source.id,
      }),
    })
  })

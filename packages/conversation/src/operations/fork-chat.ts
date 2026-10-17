import { type ChatId, type MemberId, requireChatPermission, messageId as toMessageId } from '@hq/kernel'
import type { RuntimeChatStarter } from '../contracts/runtime-chat-starter.ts'
import type { ConversationTransactor } from '../contracts/transactor.ts'
import { NotForkable } from '../domain/errors.ts'
import { newMessage } from '../domain/message.ts'
import { chatHistoryOf, runtimeChatHeaderOf, threadWrapperOf } from '../domain/thread-wrapper.ts'
import { quotedMessagesOf } from './start-runtime-from-message.ts'

type Dependencies = { transactor: ConversationTransactor; runtimeChatStarter: RuntimeChatStarter }
type Input = { id: string; chatId: ChatId; sourceChatId: ChatId; memberId: MemberId }

export const forkChat = (
  { transactor, runtimeChatStarter }: Dependencies,
  { id, chatId, sourceChatId, memberId }: Input,
) =>
  transactor.run(async ({ messages, chats, members }) => {
    await requireChatPermission(chats, sourceChatId, memberId, 'chat.read')
    const source = await chats.get(sourceChatId)
    if (source.type !== 'runtime') throw new NotForkable()
    await runtimeChatStarter.start({ id: chatId, sourceChatId, name: `${source.name} (fork)`, ownerId: memberId })
    const wrapperId = toMessageId(id)
    await messages.record({
      type: 'message.posted',
      actorId: memberId,
      message: newMessage({
        id: wrapperId,
        workspaceId: source.workspaceId,
        chatId,
        kind: 'member',
        authorId: memberId,
        body: threadWrapperOf(
          runtimeChatHeaderOf(source.name),
          await quotedMessagesOf(members, chatHistoryOf(await messages.inChat(sourceChatId))),
        ),
        createdAt: new Date(),
        replyToId: wrapperId,
      }),
    })
  })

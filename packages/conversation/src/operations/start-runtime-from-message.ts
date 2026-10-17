import {
  type ChatId,
  can,
  type MemberId,
  type MessageId,
  requireChatPermission,
  messageId as toMessageId,
} from '@hq/kernel'
import type { MemberDirectory } from '../contracts/repositories.ts'
import type { RuntimeChatStarter } from '../contracts/runtime-chat-starter.ts'
import type { ConversationTransactor } from '../contracts/transactor.ts'
import { MessageDeleted } from '../domain/errors.ts'
import { type Message, newMessage } from '../domain/message.ts'
import { chatNameFrom } from '../domain/message-body.ts'
import { channelThreadHeaderOf, threadWrapperOf } from '../domain/thread-wrapper.ts'

export const quotedMessagesOf = (members: MemberDirectory, messages: readonly Message[]) =>
  Promise.all(
    messages.map(async (message) => ({
      ...message,
      authorName: message.authorId ? await members.displayNameOf(message.authorId) : 'Agent',
    })),
  )

type Dependencies = { transactor: ConversationTransactor; runtimeChatStarter: RuntimeChatStarter }
type Input = { id: string; chatId: ChatId; messageId: MessageId; memberId: MemberId }

export const startRuntimeFromMessage = (
  { transactor, runtimeChatStarter }: Dependencies,
  { id, chatId, messageId, memberId }: Input,
) =>
  transactor.run(async ({ messages, chats, members }) => {
    const source = await messages.get(messageId)
    await requireChatPermission(chats, source.chatId, memberId, 'chat.read')
    if (source.deletedAt) throw new MessageDeleted()
    const rootId = source.threadRootId ?? source.id
    const thread = await messages.thread(rootId)
    await runtimeChatStarter.start({
      id: chatId,
      sourceChatId: source.chatId,
      name: chatNameFrom(source.body),
      ownerId: memberId,
    })
    await chats.recordRuntimeOrigin({
      runtimeChatId: chatId,
      chatId: source.chatId,
      messageId: rootId,
      startedBy: memberId,
    })
    await messages.record({
      type: 'message.posted',
      actorId: memberId,
      message: newMessage({
        id: toMessageId(id),
        workspaceId: source.workspaceId,
        chatId,
        kind: 'member',
        authorId: memberId,
        body: threadWrapperOf(
          channelThreadHeaderOf((await chats.get(source.chatId)).name),
          await quotedMessagesOf(members, thread),
        ),
        createdAt: new Date(),
        replyToId: source.id,
      }),
    })
    const otherAuthorIds = new Set(
      thread.flatMap(({ authorId, deletedAt }) => (authorId && authorId !== memberId && !deletedAt ? [authorId] : [])),
    )
    for (const authorId of otherAuthorIds)
      if (can(await chats.permissions(source.chatId, authorId), 'chat.read'))
        await chats.changeParticipant({
          type: 'member.invited',
          chatId,
          memberId: authorId,
          roleId: 'reader',
          actorId: memberId,
        })
  })

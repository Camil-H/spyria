import { type ChatId, can, type MemberId, type MessageId, requireChatPermission } from '@spyria/kernel'
import type { RuntimeChatStarter } from '../contracts/runtime-chat-starter.ts'
import type { ConversationTransactor } from '../contracts/transactor.ts'
import { MessageDeleted, RuntimeOnlyFromChannel } from '../domain/errors.ts'
import { chatNameFrom } from '../domain/message-body.ts'
import { channelThreadHeaderOf } from '../domain/seed-message.ts'
import { seedRuntimeChat } from './seed-runtime-chat.ts'

type Dependencies = { transactor: ConversationTransactor; runtimeChatStarter: RuntimeChatStarter }
type Input = { id: string; chatId: ChatId; messageId: MessageId; memberId: MemberId }

export const startRuntimeFromMessage = (
  { transactor, runtimeChatStarter }: Dependencies,
  { id, chatId, messageId, memberId }: Input,
) =>
  transactor.run(async (unitOfWork) => {
    const { messages, chats } = unitOfWork
    const source = await messages.get(messageId)
    await requireChatPermission(chats, source.chatId, memberId, 'chat.read')
    if (source.deletedAt) throw new MessageDeleted()
    const sourceChat = await chats.get(source.chatId)
    if (sourceChat.type !== 'channel') throw new RuntimeOnlyFromChannel()
    const rootId = source.threadRootId ?? source.id
    const thread = await messages.thread(source.chatId, rootId)
    await seedRuntimeChat(unitOfWork, runtimeChatStarter, {
      id,
      workspaceId: source.workspaceId,
      chatId,
      sourceChatId: source.chatId,
      name: chatNameFrom(source.body, source.attachments[0]?.name),
      memberId,
      header: channelThreadHeaderOf(sourceChat.name),
      quoted: thread,
    })
    await chats.recordRuntimeOrigin({
      runtimeChatId: chatId,
      chatId: source.chatId,
      messageId: rootId,
      startedBy: memberId,
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

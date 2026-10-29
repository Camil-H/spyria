import { type ChatId, type MemberId, memberActor, messageId as toMessageId, type WorkspaceId } from '@spyria/kernel'
import type { MemberDirectory } from '../contracts/repositories.ts'
import type { RuntimeChatStarter } from '../contracts/runtime-chat-starter.ts'
import type { UnitOfWork } from '../contracts/transactor.ts'
import { type Message, newMessage } from '../domain/message.ts'
import { seedMessageBodyOf } from '../domain/seed-message.ts'

type Seed = {
  id: string
  workspaceId: WorkspaceId
  chatId: ChatId
  sourceChatId: ChatId
  name: string
  memberId: MemberId
  header: string
  quoted: readonly Message[]
}

const quotedMessagesOf = async (members: MemberDirectory, messages: readonly Message[]) => {
  const authorNameOf = await members.displayNamesOf([
    ...new Set(messages.flatMap(({ authorId }) => (authorId ? [authorId] : []))),
  ])
  return messages.map((message) => ({
    ...message,
    authorName: message.authorId ? authorNameOf(message.authorId) : 'Agent',
  }))
}

export const seedRuntimeChat = async (
  { messages, members }: UnitOfWork,
  runtimeChatStarter: RuntimeChatStarter,
  { id, workspaceId, chatId, sourceChatId, name, memberId, header, quoted }: Seed,
) => {
  await runtimeChatStarter.start({ id: chatId, sourceChatId, name, ownerId: memberId })
  const seedId = toMessageId(id)
  await messages.record({
    type: 'message.posted',
    actor: memberActor(memberId),
    message: newMessage({
      id: seedId,
      workspaceId,
      chatId,
      kind: 'member',
      authorId: memberId,
      body: seedMessageBodyOf(header, await quotedMessagesOf(members, quoted)),
      createdAt: new Date(),
      replyToId: seedId,
    }),
  })
}

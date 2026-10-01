import type { ChatId, MemberId, MessageId, WorkspaceId } from '@hq/kernel'
import type { ConversationChat, Message } from '../domain/message.ts'

export type Draft = Readonly<{ workspaceId: WorkspaceId; chatId: ChatId; memberId: MemberId; text: string }>

export type MessageRepository = {
  get(messageId: MessageId): Promise<Message>
  add(message: Message): Promise<void>
  insertAfter(message: Message, previousMessageId: MessageId): Promise<void>
  save(message: Message): Promise<void>
}

export type DraftRepository = {
  save(draft: Draft): Promise<void>
  remove(chatId: ChatId, memberId: MemberId): Promise<void>
}

export type ChatRepository = { get(chatId: ChatId): Promise<ConversationChat> }

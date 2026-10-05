import type { ChatId, MemberId, MessageId, WorkspaceId } from '@hq/kernel'
import type { ConversationChat, Message, MessageChange } from '../domain/message.ts'

export type Draft = Readonly<{ workspaceId: WorkspaceId; chatId: ChatId; memberId: MemberId; text: string }>

export type MessageRepository = {
  get(messageId: MessageId): Promise<Message>
  record(change: MessageChange): Promise<void>
}

export type AgentReplyRequests = { request(message: Message): Promise<void> }

export type DraftRepository = { replace(draft: Draft): Promise<void> }

export type ReadMarkerRepository = { markNewestRead(chatId: ChatId, memberId: MemberId): Promise<void> }

export type ChatRepository = { get(chatId: ChatId): Promise<ConversationChat> }

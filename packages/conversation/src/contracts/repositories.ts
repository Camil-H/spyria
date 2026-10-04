import type { ChatId, MemberId, MessageId, WorkspaceId } from '@hq/kernel'
import type { ConversationChat, Message, MessageChange } from '../domain/message.ts'
import type { ReadMarker } from '../domain/read-marker.ts'

export type Draft = Readonly<{ workspaceId: WorkspaceId; chatId: ChatId; memberId: MemberId; text: string }>

export type MessageRepository = {
  get(messageId: MessageId): Promise<Message>
  record(change: MessageChange): Promise<void>
  idsInChat(chatId: ChatId): Promise<readonly MessageId[]>
}

export type AgentReplyRequests = { request(message: Message): Promise<void> }

export type DraftRepository = {
  save(draft: Draft): Promise<void>
  remove(chatId: ChatId, memberId: MemberId): Promise<void>
}

export type ReadMarkerRepository = {
  get(chatId: ChatId, memberId: MemberId): Promise<MessageId | null>
  save(marker: ReadMarker): Promise<void>
}

export type ChatRepository = { get(chatId: ChatId): Promise<ConversationChat> }

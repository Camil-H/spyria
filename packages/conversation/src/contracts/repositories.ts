import type { ChatId, MemberId, MessageId, WorkspaceId } from '@hq/kernel'
import type { AgentEvent } from '../domain/agent-events.ts'
import type { ConversationChat, Message, MessageChange } from '../domain/message.ts'

export type Draft = Readonly<{ workspaceId: WorkspaceId; chatId: ChatId; memberId: MemberId; text: string }>

export type MessageRepository = {
  get(messageId: MessageId): Promise<Message>
  record(change: MessageChange): Promise<void>
  project(message: Message, seq: number): Promise<void>
  setDetail(messageId: MessageId, detail: string): Promise<void>
}

export type AgentPromptRequests = { request(message: Message): Promise<void> }

export type AgentTurnRepository = {
  lock(chatId: ChatId): Promise<MessageId | null>
  set(chatId: ChatId, promptId: MessageId | null): Promise<void>
  nextPrompt(chatId: ChatId): Promise<Message | undefined>
  hasReply(promptId: MessageId): Promise<boolean>
}

export type AgentEventRepository = {
  append(chatId: ChatId, event: AgentEvent, replyToId: MessageId | null, at: Date): Promise<number | undefined>
  lastTimestamp(chatId: ChatId): Promise<string | null>
}

export type DraftRepository = { replace(draft: Draft): Promise<void> }

export type ReadMarkerRepository = { markNewestRead(chatId: ChatId, memberId: MemberId): Promise<void> }

export type ChatRepository = { get(chatId: ChatId): Promise<ConversationChat> }

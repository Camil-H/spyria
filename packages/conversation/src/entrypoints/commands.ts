import type { ChatId, MessageId, WorkspaceId } from '@hq/kernel'
import type { StreamFrame } from '../domain/streamed-reply.ts'

type Command<Input, Result = string> = (input: Input & { workspaceId: WorkspaceId }) => Promise<Result>

export type ConversationCommands = {
  sendMessage: Command<{ chatId: ChatId; text: string }>
  editMessage: Command<{ messageId: MessageId; text: string }>
  deleteMessage: Command<{ messageId: MessageId }>
  markChatRead: Command<{ chatId: ChatId }>
  stopAgent: Command<{ chatId: ChatId }>
  retryAgent: Command<{ chatId: ChatId }>
  startRuntimeFromMessage: Command<{ messageId: MessageId }>
  saveDraft: Command<{ chatId: ChatId; text: string }, void>
  commandOutput: Command<{ chatId: ChatId; stepId: string }>
}

export type AgentStream = {
  subscribe(workspaceId: WorkspaceId, chatId: ChatId, listener: (frame: StreamFrame) => void): () => void
}

import type { ChatId, MessageId, WorkspaceId } from '@hq/kernel'
import type { StoredFrame, StreamFrame } from '../domain/streamed-reply.ts'
import type { ChatRoutingRead } from './endpoints.ts'

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
  connectTool: Command<{ tool: string }, unknown>
  updateChatRouting: Command<{
    chatId: ChatId
    sessionModel?: string
    defaultModel?: string
    subagentPolicy?: 'auto' | 'same_as_main'
  }>
  chatRouting: Command<{ chatId: ChatId }, ChatRoutingRead>
}

export type AgentStream = {
  subscribe(workspaceId: WorkspaceId, chatId: ChatId, listener: (frame: StreamFrame | StoredFrame) => void): () => void
}

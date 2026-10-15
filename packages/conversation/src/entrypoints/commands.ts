import type { ChatId, MessageId, WorkspaceId } from '@hq/kernel'
import type { RunsOn } from '../domain/session-routing.ts'
import type { QuestionFrame, StoredFrame, StreamFrame, WorkspaceFrame } from '../domain/streamed-reply.ts'
import type { ChatRoutingRead, QuestionAnswer } from './endpoints.ts'

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
    runsOn?: RunsOn
    acpModel?: string
  }>
  chatRouting: Command<{ chatId: ChatId }, ChatRoutingRead>
  answerQuestion: Command<{ chatId: ChatId; questionId: string; answer: QuestionAnswer }, number>
  setPlanMode: Command<{ chatId: ChatId; enabled: boolean }, number>
}

export type AgentStream = {
  subscribe(
    workspaceId: WorkspaceId,
    chatId: ChatId,
    listener: (frame: StreamFrame | StoredFrame | QuestionFrame | WorkspaceFrame) => void,
  ): () => void
}

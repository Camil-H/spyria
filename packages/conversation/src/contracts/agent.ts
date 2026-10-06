import type { ChatId, MessageId, WorkspaceId } from '@hq/kernel'
import type { AgentEvent } from '../domain/agent-events.ts'

export type AgentChat = Readonly<{ workspaceId: WorkspaceId; chatId: ChatId }>
export type AgentSocket = { send(data: string): void; close(): void }
export type AgentTransport = {
  fetch(request: {
    method: string
    path: string
    headers?: Record<string, string>
    body?: string
    timeoutMilliseconds?: number
  }): Promise<{ status: number; body: string }>
  openSocket(path: string, listener: { onOpen(): void; onMessage(data: string): void; onClose(): void }): AgentSocket
}
export type AgentEndpoint = Readonly<{
  transport: AgentTransport
  apiKey: string
  llmToken: string
  conversationId: string | null
}>
export type AgentConversation = AgentEndpoint & { conversationId: string }
export type RuntimeReadiness =
  | { state: 'ready'; endpoint: AgentEndpoint }
  | { state: 'starting' }
  | { state: 'failed'; failure: string | null }

export type AgentRuntimes = {
  ensureRunning(chat: AgentChat): Promise<RuntimeReadiness>
  endpointOf(chat: AgentChat): Promise<AgentEndpoint | undefined>
  rememberConversation(chat: AgentChat, conversationId: string): Promise<string>
  touch(chat: AgentChat): Promise<void>
}

export type AgentEventListener = { onEvent(event: AgentEvent): void; onClose(): void }
export type AgentServer = {
  createConversation(endpoint: AgentEndpoint): Promise<string>
  sendMessage(conversation: AgentConversation, text: string): Promise<void>
  openEvents(conversation: AgentConversation, afterTimestamp: string | null, listener: AgentEventListener): AgentSocket
}

export type AgentEventSockets = {
  ensureOpen(chat: AgentChat, conversation: AgentConversation, promptId: MessageId): Promise<void>
}

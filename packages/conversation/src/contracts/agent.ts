import type { ChatId, MemberId, MessageId, RuntimeHostId, WorkspaceId } from '@hq/kernel'
import type { AgentEvent } from '../domain/agent-events.ts'

export type AgentChat = Readonly<{ workspaceId: WorkspaceId; chatId: ChatId }>
export type AgentHost = Readonly<{ workspaceId: WorkspaceId; hostId: RuntimeHostId }>
export type AgentInterrupt = Readonly<{ chatId: ChatId; promptId: MessageId; memberId: MemberId }>
export type AgentSocket = { send(data: string): void; close(): void }
export type AgentTransport = {
  gatewayUrl: string
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
  conversationId: string | null
}>
export type AgentConversation = AgentEndpoint & { conversationId: string }
export type RuntimeReadiness =
  | { state: 'ready'; endpoint: AgentEndpoint }
  | { state: 'starting' }
  | { state: 'host_offline' }
  | { state: 'failed'; failure: string | null }

export type AgentRuntimes = {
  ensureRunning(chat: AgentChat): Promise<RuntimeReadiness>
  endpointOf(chat: AgentChat): Promise<AgentEndpoint | undefined>
  rememberConversation(chat: AgentChat, conversationId: string): Promise<string>
  forgetConversation(chat: AgentChat): Promise<void>
  issueLlmToken(chat: AgentChat): Promise<string>
  chatOfLlmToken(host: AgentHost, token: string): Promise<ChatId | undefined>
  chatsOnHost(host: AgentHost): Promise<ChatId[]>
  touch(chat: AgentChat): Promise<void>
}

export type RuntimeRetrier = { retry(chat: AgentChat): Promise<void> }

export type AgentEventListener = { onEvent(event: AgentEvent): void; onClose(): void }
export type AgentServer = {
  createConversation(endpoint: AgentEndpoint, llmToken: string): Promise<string>
  sendMessage(conversation: AgentConversation, text: string): Promise<void>
  statusOf(conversation: AgentConversation): Promise<string | undefined>
  interrupt(conversation: AgentConversation): Promise<void>
  openEvents(conversation: AgentConversation, afterTimestamp: string | null, listener: AgentEventListener): AgentSocket
}

export type AgentEventSockets = {
  ensureOpen(chat: AgentChat, conversation: AgentConversation, promptId: MessageId): Promise<void>
  stopStreaming(chat: AgentChat, promptId: MessageId): void
}

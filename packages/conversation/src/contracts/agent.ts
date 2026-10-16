import type { ChatId, ListedModel, MemberId, MessageId, Model, RuntimeHostId, WorkspaceId } from '@hq/kernel'
import type { AgentEvent } from '../domain/agent-events.ts'
import type { HarnessLaunch } from '../domain/session-routing.ts'
import type { DelegatedFrame } from '../domain/streamed-reply.ts'

export class AgentStartFailure extends Error {}

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
  | { state: 'ready'; endpoint: AgentEndpoint; signedIn: readonly string[] }
  | { state: 'starting' }
  | { state: 'host_offline' }
  | { state: 'failed'; failure: string | null }

export type AgentRuntimes = {
  ensureRunning(chat: AgentChat): Promise<RuntimeReadiness>
  endpointOf(chat: AgentChat): Promise<AgentEndpoint | undefined>
  isWaitingOnHost(chat: AgentChat): Promise<boolean>
  rememberConversation(chat: AgentChat, conversationId: string): Promise<string>
  forgetConversation(chat: AgentChat): Promise<void>
  issueLlmToken(chat: AgentChat): Promise<string>
  chatOfLlmToken(host: AgentHost, token: string): Promise<ChatId | undefined>
  chatsOnHost(host: AgentHost): Promise<ChatId[]>
  touch(chat: AgentChat): Promise<void>
  expireSignIn(chat: AgentChat, tool: string): Promise<void>
}

export type RuntimeRetrier = { retry(chat: AgentChat): Promise<void> }

export type AgentLastEvent = Readonly<{ id: string; seq: number | null; timestamp: string }>
export type AgentEventListener = { onEvent(event: AgentEvent): void; onClose(): void }
export type AgentLlmChoice = Readonly<
  { effort?: string; resumeSessionId?: string; adapterModel?: string } & ({ harness: HarnessLaunch } | { pi: PiLaunch })
>
export type PiModel = Readonly<Pick<Model, 'id' | 'name' | 'contextWindow'> & { reasoning: boolean }>
export type PiLaunch = Readonly<{
  models: readonly PiModel[]
  compactionModel: string
  compaction?: Readonly<{ reserveTokens: number; keepRecentTokens: number }>
}>
export type SubConversation = Readonly<{ parentConversationId: string }>
export type AgentClient = {
  createConversation(
    conversation: AgentConversation,
    llmToken: string,
    llm: AgentLlmChoice,
    sub?: SubConversation,
  ): Promise<void>
  switchModel(conversation: AgentConversation, model: string, thoughtLevel?: string): Promise<void>
  sendMessage(conversation: AgentConversation, text: string): Promise<void>
  answerQuestion(conversation: AgentConversation, questionId: string, answer: object): Promise<number>
  setPlanMode(conversation: AgentConversation, enabled: boolean): Promise<number>
  statusOf(conversation: AgentConversation): Promise<string | undefined>
  interrupt(conversation: AgentConversation): Promise<void>
  deleteConversation(conversation: AgentConversation): Promise<void>
  openEvents(conversation: AgentConversation, last: AgentLastEvent | null, listener: AgentEventListener): AgentSocket
}

export type AgentEventSockets = {
  ensureOpen(chat: AgentChat, conversation: AgentConversation, promptId: MessageId | null): Promise<void>
  stopStreaming(chat: AgentChat, promptId: MessageId): void
  streamDelegated(chat: AgentChat, frame: DelegatedFrame): void
}

export type ClassifierCall = Readonly<{
  chat: AgentChat
  prompterId: MemberId
  ownerId: MemberId | null
  model: Model
  request: object
}>
export type SessionClassifier = {
  listedModels(): readonly ListedModel[]
  classify(
    call: ClassifierCall,
  ): Promise<{ body: unknown; inputTokens: number; outputTokens: number } | { failure: string }>
}

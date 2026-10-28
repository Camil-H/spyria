import type {
  ChatId,
  HarnessId,
  ListedModel,
  MemberId,
  MessageId,
  Model,
  RuntimeHostId,
  WorkspaceId,
} from '@spyria/kernel'
import type { AgentEvent } from '../domain/agent-events.ts'
import type { Issue, IssueFilter, IssueSummary, PullRequestChange, ReviewThread } from '../domain/github-tools.ts'
import type { PullRequestDraft, PullRequestStep } from '../domain/pull-requests.ts'
import type { DelegatedFrame, QuestionFrame } from '../domain/streamed-reply.ts'

export class AgentStartFailure extends Error {}

export type AgentChat = Readonly<{ workspaceId: WorkspaceId; chatId: ChatId }>
export type AgentHost = Readonly<{ workspaceId: WorkspaceId; hostId: RuntimeHostId }>
export type AgentInterrupt = Readonly<{ chatId: ChatId; promptId: MessageId; memberId: MemberId }>
export type SessionRestart = Readonly<{ chatId: ChatId; memberId: MemberId }>
type AgentSocket = { send(data: string): void; close(): void }
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
  snapshotOf(chat: AgentChat): Promise<string | undefined>
  keepSnapshot(chat: AgentChat, snapshot: string): Promise<void>
}

export type RuntimeRetrier = { retry(chat: AgentChat): Promise<void> }

type AgentLastEvent = Readonly<{ id: string; seq: number | null; timestamp: string }>
export type AgentEventListener = { onEvent(event: AgentEvent): void; onClose(): void }
export type AgentLlmChoice = Readonly<
  { effort?: string; resumeSessionId?: string; adapterModel?: string } & ({ harness: HarnessId } | { pi: PiLaunch })
>
export type PiModel = Readonly<Pick<Model, 'id' | 'name' | 'contextWindow'> & { reasoning: boolean }>
export type PiLaunch = Readonly<{
  models: readonly PiModel[]
  compactionModel: string
  compaction?: Readonly<{ reserveTokens: number; keepRecentTokens: number }>
}>
export type SubConversation = Readonly<{ parentConversationId: string }>
export type RepositoryCheckout = Readonly<{
  url: string
  token: string
  baseBranch: string
  workingBranch: string
  startBranch?: string
  author?: GitAuthor
}>
export type WorkspaceAction = 'commit' | 'fetch' | 'merge' | 'pushed' | 'screenshot'
export type BranchBundle = Readonly<{ bundle: string } | { failure: string }>
export type BundleOf = (branch: string, prerequisite: string | null) => Promise<BranchBundle>
export type GitAuthor = Readonly<{ name: string; email: string }>
export type FetchedBundle = Readonly<{ head: string; bundle: string } | { failure: string }>
export type RepositoryCheckouts = {
  checkoutOf(chat: AgentChat): Promise<RepositoryCheckout | undefined>
  pushBranch(
    chat: AgentChat,
    ownerId: MemberId,
    bundleOf: BundleOf,
  ): Promise<{ branch: string; head?: string | undefined; failure?: string } | undefined>
  fetchBundle(chat: AgentChat, branch: string | null, runtimeHeads: string[]): Promise<FetchedBundle>
  authorOf(chat: AgentChat, ownerId: MemberId): Promise<GitAuthor | undefined>
  openPullRequest(chat: AgentChat, ownerId: MemberId, draft: PullRequestDraft): Promise<PullRequestStep>
  refreshPullRequest(chat: AgentChat, ownerId: MemberId, pullRequest: PullRequestStep): Promise<PullRequestStep>
  updatePullRequest(
    chat: AgentChat,
    ownerId: MemberId,
    pullRequest: PullRequestStep,
    change: PullRequestChange,
  ): Promise<PullRequestStep>
  reviewThreadsOf(chat: AgentChat, number: number): Promise<ReviewThread[]>
  issuesOf(chat: AgentChat, filter: IssueFilter): Promise<IssueSummary[]>
  issueOf(chat: AgentChat, number: number): Promise<Issue>
}
export type AgentClient = {
  createConversation(
    conversation: AgentConversation,
    llmToken: string,
    llm: AgentLlmChoice,
    sub?: SubConversation,
    checkout?: RepositoryCheckout,
  ): Promise<void>
  switchModel(conversation: AgentConversation, model: string | undefined, thoughtLevel?: string): Promise<void>
  sendMessage(conversation: AgentConversation, text: string): Promise<void>
  answerQuestion(conversation: AgentConversation, questionId: string, answer: object): Promise<number>
  statusOf(conversation: AgentConversation): Promise<string | undefined>
  interrupt(conversation: AgentConversation): Promise<void>
  restartConversation(conversation: AgentConversation): Promise<string>
  deleteConversation(conversation: AgentConversation): Promise<void>
  readWorkspace(endpoint: AgentEndpoint, path: string): Promise<object | undefined>
  readMedia(endpoint: AgentEndpoint, path: string): Promise<Uint8Array<ArrayBuffer> | undefined>
  bundleBranch(endpoint: AgentEndpoint, branch: string, prerequisite: string | null): Promise<BranchBundle>
  actOnWorkspace(
    endpoint: AgentEndpoint,
    action: WorkspaceAction,
    body: object,
  ): Promise<Readonly<{ failure: string } | { [field: string]: unknown }>>
  openEvents(conversation: AgentConversation, last: AgentLastEvent | null, listener: AgentEventListener): AgentSocket
}

export type AgentEventSockets = {
  ensureOpen(chat: AgentChat, conversation: AgentConversation, promptId: MessageId | null): Promise<void>
  stopStreaming(chat: AgentChat, promptId: MessageId): void
  streamDelegated(chat: AgentChat, frame: DelegatedFrame): void
  showQuestion(chat: AgentChat, frame: QuestionFrame): void
  hideQuestion(chat: AgentChat, questionId: string): void
}

type ClassifierCall = Readonly<{
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

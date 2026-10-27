import type {
  ChatId,
  ChatPermission,
  ChatRole,
  HarnessId,
  ListedModel,
  MemberId,
  MessageId,
  Model,
  WorkspaceId,
} from '@spyria/kernel'
import type { AgentEvent } from '../domain/agent-events.ts'
import type { StepDelegation, StoredStep } from '../domain/agent-steps.ts'
import type { Attachment, StoredBytes } from '../domain/attachments.ts'
import type { OpenedPage } from '../domain/browser-pages.ts'
import type { ConversationChat, Message, MessageChange } from '../domain/message.ts'
import type { AgentInterrupt, SessionRestart } from './agent.ts'

export type Draft = Readonly<{ workspaceId: WorkspaceId; chatId: ChatId; memberId: MemberId; text: string }>

export type MessageRepository = {
  get(messageId: MessageId): Promise<Message>
  record(change: MessageChange): Promise<void>
  project(message: Message, seq: number): Promise<void>
  find(messageId: MessageId): Promise<Message | undefined>
  setStep(messageId: MessageId, step: StoredStep): Promise<void>
  replies(promptId: MessageId): Promise<Message[]>
  openTaskSteps(promptId: MessageId): Promise<{ id: string; step: StoredStep }[]>
  thread(chatId: ChatId, rootId: MessageId): Promise<Message[]>
  history(chatId: ChatId): Promise<Message[]>
  seedFor(prompt: Message): Promise<Message | undefined>
  pullRequestCard(chatId: ChatId): Promise<Message | undefined>
}

export type AttachmentRepository = {
  store(attachment: Attachment & { chatId: ChatId; uploaderId: MemberId; content: Uint8Array }): Promise<void>
  claim(chatId: ChatId, uploaderId: MemberId, requested: readonly Attachment[]): Promise<readonly Attachment[]>
  link(messageId: MessageId, attachments: readonly Attachment[]): Promise<void>
  discard(messageId: MessageId): Promise<void>
  storedBytes(uploaderId: MemberId): Promise<StoredBytes>
}

export type AgentJobs = {
  prompt(message: Message): Promise<void>
  startSession(chatId: ChatId): Promise<void>
  interrupt(interrupt: AgentInterrupt): Promise<void>
  restartSession(restart: SessionRestart): Promise<void>
  sweepLater(): Promise<void>
}

export type AgentTurnRepository = {
  lock(chatId: ChatId): Promise<MessageId | null>
  set(chatId: ChatId, prompt: Pick<Message, 'id' | 'authorId'> | null): Promise<void>
  modelCallTurn(chatId: ChatId): Promise<ModelCallTurn | undefined>
  toolCallTurn(
    chatId: ChatId,
  ): Promise<{ ownerId: MemberId | null; prompterId: MemberId | null; promptId: MessageId | null }>
  recordFailure(chatId: ChatId, promptId: MessageId, notice: string): Promise<void>
  lastFailure(chatId: ChatId): Promise<string | null>
  nextPrompt(chatId: ChatId): Promise<Message | undefined>
  waitingPrompts(chatId: ChatId): Promise<Message[]>
  hasReply(promptId: MessageId): Promise<boolean>
  hasNotice(promptId: MessageId, text: string): Promise<boolean>
  active(): Promise<{ chatId: ChatId; promptId: MessageId; lastEventAt: number }[]>
}

export type ToolCallDecision = 'not_needed' | 'approved' | 'denied' | 'expired' | 'cancelled'
export type ToolCall = Readonly<{
  chatId: ChatId
  prompterId: MemberId
  ownerId: MemberId
  server: string
  tool: string
  readOnly: boolean | null
  decision: ToolCallDecision
  decidedBy: MemberId | null
  status: 'succeeded' | 'failed' | 'refused'
  calledAt: Date
}>
export type ToolCallRepository = { record(call: ToolCall): Promise<void> }

export type ModelCallTurn = {
  promptId: MessageId
  prompterId: MemberId
  ownerId: MemberId | null
  sessionId: string | null
}

export type MemberDirectory = {
  displayNameOf(memberId: MemberId): Promise<string>
  displayNamesOf(memberIds: readonly MemberId[]): Promise<(memberId: MemberId) => string>
  hasLlmCredential(memberId: MemberId): Promise<boolean>
  isMember(memberId: MemberId): Promise<boolean>
}

export type AgentEventRepository = {
  append(
    chatId: ChatId,
    event: AgentEvent,
    replyToId: MessageId | null,
    at: Date,
    delegation?: StepDelegation,
  ): Promise<number | undefined>
  last(
    chatId: ChatId,
  ): Promise<
    | { id: string; seq: number | null; timestamp: string; replyToId: MessageId | null; sessionUpdate?: string | null }
    | undefined
  >
  lastSessionId(chatId: ChatId): Promise<string | undefined>
}

export type DraftRepository = { replace(draft: Draft): Promise<void> }

export type BrowserPageRepository = { open(chatId: ChatId, page: OpenedPage, openedAt: Date): Promise<void> }

export type ReadMarkerRepository = {
  markNewestRead(chatId: ChatId, memberId: MemberId): Promise<void>
  markThreadRead(chatId: ChatId, threadRootId: MessageId, memberId: MemberId): Promise<void>
}

export type ParticipantChange = Readonly<{
  type: 'member.invited' | 'member.joined' | 'member.role_changed' | 'member.removed' | 'member.left'
  chatId: ChatId
  memberId: MemberId
  roleId: string | null
  actorId: MemberId
}>

export type RuntimeOrigin = Readonly<{
  runtimeChatId: ChatId
  chatId: ChatId
  messageId: MessageId
  startedBy: MemberId
}>

export type ChatRepository = {
  get(chatId: ChatId): Promise<ConversationChat>
  permissions(chatId: ChatId, memberId: MemberId): Promise<readonly ChatPermission[]>
  join(chatId: ChatId, memberId: MemberId): Promise<void>
  roleOf(chatId: ChatId, memberId: MemberId): Promise<string | undefined>
  role(roleId: string): Promise<ChatRole | undefined>
  changeParticipant(change: ParticipantChange): Promise<void>
  recordRuntimeOrigin(origin: RuntimeOrigin): Promise<void>
  recordPush(push: { chatId: ChatId; actorId: MemberId; branch: string; head: string | null }): Promise<void>
  localSessionsAllowed(): Promise<boolean>
  hasAgentSession(chatId: ChatId): Promise<boolean>
  isSessionStartPending(chatId: ChatId): Promise<boolean>
  dropRuntime(chatId: ChatId): Promise<void>
  stopRuntime(chatId: ChatId): Promise<void>
  hasMachine(memberId: MemberId): Promise<boolean>
}

type ChatRouting = Readonly<{
  mode: string | null
  ownerId: MemberId | null
  model: string | null
  reasoningEffort: string | null
  agentModel: string | null
  agentReasoningEffort: string | null
  subagentPolicy: string
  harness: HarnessId | null
}>
type RoutingDecision = Readonly<{
  chatId: ChatId
  conversationId: string | null
  role: 'session' | 'manual'
  memberId: MemberId
  inputsDigest: string | null
  classifierOutput: object | null
  model: string
  reason: string
  costMicros: number
}>
export type Delegation = Readonly<{
  chatId: ChatId
  id: string
  promptId: MessageId
  task: string
  effortHint: string
  policy: string
  classifierOutput: object | null
  model: string
  reason: string
  tokenHash: string
}>
export type DelegationRepository = {
  start(delegation: Delegation): Promise<void>
  update(id: string, fields: { conversationId?: string; status?: 'finished' | 'failed' }): Promise<void>
  stopRunning(chatId: ChatId, promptId: MessageId): Promise<string[]>
  runningOfTokenHash(
    hostId: string,
    tokenHash: string,
  ): Promise<{ chatId: ChatId; id: string; promptId: MessageId } | undefined>
}

export type RoutingRepository = {
  chatRouting(chatId: ChatId): Promise<ChatRouting>
  reachableModels(memberId: MemberId): Promise<readonly Model[] | undefined>
  listedModels(): readonly ListedModel[]
  update(
    chatId: ChatId,
    fields: Partial<{
      model: string | null
      reasoningEffort: string
      subagentPolicy: string
      harness: HarnessId | null
      localSession: boolean
    }>,
  ): Promise<void>
  setAgentModel(chatId: ChatId, model: string | null, reasoningEffort: string | null): Promise<void>
  record(decision: RoutingDecision): Promise<void>
}

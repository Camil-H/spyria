import type { Transactor } from '@spyria/kernel'
import type {
  AgentEventRepository,
  AgentJobs,
  AgentTurnRepository,
  AttachmentRepository,
  ChatRepository,
  DelegationRepository,
  MemberDirectory,
  MessageRepository,
  PlanRepository,
  ReadMarkerRepository,
  RoutingRepository,
  ToolCallRepository,
} from './repositories.ts'

export type UnitOfWork = {
  messages: MessageRepository
  attachments: AttachmentRepository
  readMarkers: ReadMarkerRepository
  chats: ChatRepository
  agentJobs: AgentJobs
  members: MemberDirectory
  agentTurns: AgentTurnRepository
  agentEvents: AgentEventRepository
  plans: PlanRepository
  routing: RoutingRepository
  delegations: DelegationRepository
  toolCalls: ToolCallRepository
}

export type ConversationTransactor = Transactor<UnitOfWork>

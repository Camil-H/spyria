import type { Transactor } from '@spyria/kernel'
import type {
  AgentEventRepository,
  AgentJobs,
  AgentTurnRepository,
  AttachmentRepository,
  BrowserPageRepository,
  ChatRepository,
  DelegationRepository,
  MemberDirectory,
  MessageRepository,
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
  browserPages: BrowserPageRepository
  routing: RoutingRepository
  delegations: DelegationRepository
  toolCalls: ToolCallRepository
}

export type ConversationTransactor = Transactor<UnitOfWork>

import type { Transactor } from '@hq/kernel'
import type {
  AgentEventRepository,
  AgentJobs,
  AgentTurnRepository,
  ChatRepository,
  DelegationRepository,
  MemberDirectory,
  MessageRepository,
  PlanRepository,
  ReadMarkerRepository,
  RoutingRepository,
} from './repositories.ts'

export type UnitOfWork = {
  messages: MessageRepository
  readMarkers: ReadMarkerRepository
  chats: ChatRepository
  agentJobs: AgentJobs
  members: MemberDirectory
  agentTurns: AgentTurnRepository
  agentEvents: AgentEventRepository
  plans: PlanRepository
  routing: RoutingRepository
  delegations: DelegationRepository
}

export type ConversationTransactor = Transactor<UnitOfWork>

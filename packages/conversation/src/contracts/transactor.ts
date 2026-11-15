import type { Transactor } from '@spyria/kernel'
import type {
  AgentEventRepository,
  AgentJobs,
  AgentTurnRepository,
  AttachmentRepository,
  BrowserPageRepository,
  BrowserRepository,
  ChatRepository,
  DelegationRepository,
  DevLoopRepository,
  MemberDirectory,
  MessageRepository,
  PublicChatDirectory,
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
  browser: BrowserRepository
  publicChats: PublicChatDirectory
  routing: RoutingRepository
  delegations: DelegationRepository
  toolCalls: ToolCallRepository
  devLoop: DevLoopRepository
}

export type ConversationTransactor = Transactor<UnitOfWork>

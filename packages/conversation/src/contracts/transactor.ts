import type {
  AgentEventRepository,
  AgentJobs,
  AgentTurnRepository,
  ChatRepository,
  MemberDirectory,
  MessageRepository,
  PlanRepository,
  ReadMarkerRepository,
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
}

export type ConversationTransactor = {
  run<Result>(work: (unitOfWork: UnitOfWork) => Promise<Result>): Promise<Result>
}

import type {
  AgentEventRepository,
  AgentPromptRequests,
  AgentTurnRepository,
  ChatRepository,
  MessageRepository,
  ReadMarkerRepository,
} from './repositories.ts'

export type UnitOfWork = {
  messages: MessageRepository
  readMarkers: ReadMarkerRepository
  chats: ChatRepository
  agentPrompts: AgentPromptRequests
  agentTurns: AgentTurnRepository
  agentEvents: AgentEventRepository
}

export type ConversationTransactor = {
  run<Result>(work: (unitOfWork: UnitOfWork) => Promise<Result>): Promise<Result>
}

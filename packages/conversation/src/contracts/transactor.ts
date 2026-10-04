import type { AgentReplyRequests, ChatRepository, MessageRepository, ReadMarkerRepository } from './repositories.ts'

export type UnitOfWork = {
  messages: MessageRepository
  readMarkers: ReadMarkerRepository
  chats: ChatRepository
  agentReplies: AgentReplyRequests
}

export type ConversationTransactor = {
  run<Result>(work: (unitOfWork: UnitOfWork) => Promise<Result>): Promise<Result>
}

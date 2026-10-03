import type { ChatRepository, DraftRepository, MessageRepository, ReadMarkerRepository } from './repositories.ts'

export type UnitOfWork = {
  messages: MessageRepository
  drafts: DraftRepository
  readMarkers: ReadMarkerRepository
  chats: ChatRepository
}

export type ConversationTransactor = {
  run<Result>(work: (unitOfWork: UnitOfWork) => Promise<Result>): Promise<Result>
}

import type { ChatRepository, DraftRepository, MessageRepository } from './repositories.ts'

export type UnitOfWork = { messages: MessageRepository; drafts: DraftRepository; chats: ChatRepository }

export type ConversationTransactor = {
  run<Result>(work: (unitOfWork: UnitOfWork) => Promise<Result>): Promise<Result>
}

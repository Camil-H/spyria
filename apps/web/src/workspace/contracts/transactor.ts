import type { ChatRepository, ProjectRepository } from './repositories.ts'

export type UnitOfWork = { projects: ProjectRepository; chats: ChatRepository }

export type Transactor = {
  run<Result>(work: (unitOfWork: UnitOfWork) => Promise<Result>): Promise<Result>
}

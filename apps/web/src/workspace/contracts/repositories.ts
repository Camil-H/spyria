import type { ChatId, ProjectId } from '@hq/kernel'
import type { Chat } from '../domain/chat.ts'
import type { Project } from '../domain/project.ts'

export type ProjectRepository = {
  get(projectId: ProjectId): Promise<Project>
  add(project: Project): Promise<void>
  save(project: Project): Promise<void>
}

export type ChatRepository = {
  get(chatId: ChatId): Promise<Chat>
  add(chat: Chat): Promise<void>
  save(chat: Chat): Promise<void>
  listByProject(projectId: ProjectId): Promise<Chat[]>
}

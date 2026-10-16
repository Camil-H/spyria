import type { ChatId, ChatPermission, MemberId, ProjectId } from '@hq/kernel'
import type { Chat, ChatChange } from '../domain/chat.ts'
import type { Project } from '../domain/project.ts'
import type { Membership, Workspace } from '../domain/workspace.ts'

export type ProjectRepository = {
  get(projectId: ProjectId): Promise<Project>
  add(project: Project): Promise<void>
  save(project: Project): Promise<void>
}

export type ChatRepository = {
  get(chatId: ChatId): Promise<Chat>
  record(change: ChatChange): Promise<void>
  listByProject(projectId: ProjectId): Promise<Chat[]>
  permissions(chatId: ChatId, memberId: MemberId): Promise<readonly ChatPermission[]>
}

export type WorkspaceRepository = {
  add(workspace: Workspace): Promise<void>
}

export type MembershipRepository = {
  add(membership: Membership): Promise<void>
}

export type ChatRuntimeRepository = {
  remove(chatId: ChatId): Promise<void>
}

import type { Transactor } from '@hq/kernel'
import type {
  ChatRepository,
  ChatRuntimeRepository,
  MemberModelDirectory,
  MembershipRepository,
  ProjectRepository,
  WorkspaceRepository,
} from './repositories.ts'

export type UnitOfWork = {
  workspaces: WorkspaceRepository
  memberships: MembershipRepository
  projects: ProjectRepository
  chats: ChatRepository
  chatRuntimes: ChatRuntimeRepository
  memberModels: MemberModelDirectory
}

export type WorkspaceTransactor = Transactor<UnitOfWork>

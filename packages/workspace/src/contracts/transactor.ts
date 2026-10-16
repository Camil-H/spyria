import type { Transactor } from '@hq/kernel'
import type {
  ChatRepository,
  ChatRuntimeRepository,
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
}

export type WorkspaceTransactor = Transactor<UnitOfWork>

import type { Transactor } from '@hq/kernel'
import type {
  ChatRepository,
  ChatRuntimeRepository,
  InvitationRepository,
  MemberAccess,
  MembershipRepository,
  ProjectRepository,
  WorkspaceEventLog,
  WorkspaceRepository,
} from './repositories.ts'

export type UnitOfWork = {
  workspaces: WorkspaceRepository
  memberships: MembershipRepository
  projects: ProjectRepository
  chats: ChatRepository
  chatRuntimes: ChatRuntimeRepository
  invitations: InvitationRepository
  memberAccess: MemberAccess
  workspaceEvents: WorkspaceEventLog
}

export type WorkspaceTransactor = Transactor<UnitOfWork>

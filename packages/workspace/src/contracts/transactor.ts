import type { Transactor } from '@spyria/kernel'
import type {
  ChatRepository,
  ChatRoleRepository,
  ChatRuntimeRepository,
  InvitationRepository,
  MemberAccess,
  MembershipRepository,
  ProjectRepository,
  WorkspaceEventLog,
  WorkspaceRepository,
  WorkspaceRoleRepository,
} from './repositories.ts'

export type UnitOfWork = {
  workspaces: WorkspaceRepository
  memberships: MembershipRepository
  projects: ProjectRepository
  chats: ChatRepository
  chatRoles: ChatRoleRepository
  workspaceRoles: WorkspaceRoleRepository
  chatRuntimes: ChatRuntimeRepository
  invitations: InvitationRepository
  memberAccess: MemberAccess
  workspaceEvents: WorkspaceEventLog
}

export type WorkspaceTransactor = Transactor<UnitOfWork>

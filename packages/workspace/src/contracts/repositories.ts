import type {
  ChatId,
  ChatPermission,
  ChatRole,
  MemberId,
  ProjectId,
  WorkspacePermission,
  WorkspaceRole,
} from '@spyria/kernel'
import type { Chat, ChatChange } from '../domain/chat.ts'
import type { Invitation } from '../domain/invitation.ts'
import type { Member } from '../domain/member.ts'
import type { Project } from '../domain/project.ts'
import type { RoleHolders, StoredChatRole, StoredWorkspaceRole, WorkspaceRoleHolders } from '../domain/role.ts'
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
  participantRoles(chatId: ChatId): Promise<{ memberId: MemberId; permissions: readonly ChatPermission[] }[]>
  changeRole(change: { chatId: ChatId; memberId: MemberId; roleId: string; actorId: MemberId }): Promise<void>
  listRuntimeChats(): Promise<Chat[]>
  participatedBy(memberId: MemberId): Promise<Chat[]>
  removeParticipant(change: { chatId: ChatId; memberId: MemberId; actorId: MemberId }): Promise<void>
  transfer(change: { chat: Chat; ownerId: MemberId; actorId: MemberId }): Promise<void>
}

export type ChatRoleRepository = {
  get(roleId: string): Promise<StoredChatRole | undefined>
  list(): Promise<ChatRole[]>
  holders(roleId: string): Promise<RoleHolders>
  add(role: ChatRole): Promise<void>
  save(role: ChatRole): Promise<void>
  remove(roleId: string): Promise<void>
}

export type WorkspaceRoleRepository = {
  get(roleId: string): Promise<StoredWorkspaceRole | undefined>
  list(): Promise<WorkspaceRole[]>
  holders(roleId: string): Promise<WorkspaceRoleHolders>
  add(role: WorkspaceRole): Promise<void>
  save(role: WorkspaceRole): Promise<void>
  remove(roleId: string): Promise<void>
}

export type WorkspaceRepository = {
  add(workspace: Workspace): Promise<void>
  scheduleDeletion(deletion: { purgeAt: number; haltDelayMilliseconds: number; actorId: MemberId }): Promise<void>
}

export type WorkspaceCleanup = { isPending: boolean; failed: readonly { type: string; count: number }[] }

export type DeletedWorkspace = {
  isDeleted(): Promise<boolean>
  lockIfPurgeDue(): Promise<boolean>
  halt(): Promise<void>
  release(): Promise<void>
  deleteLater(delayMilliseconds: number): Promise<void>
  cleanup(): Promise<WorkspaceCleanup>
  reportFailedCleanup(cleanup: WorkspaceCleanup): Promise<void>
  deleteChunk(): Promise<number>
  deleteAll(): Promise<void>
}

export type MembershipRepository = {
  add(membership: Membership): Promise<void>
  get(memberId: MemberId): Promise<Member | undefined>
  findByEmail(email: string): Promise<Member | undefined>
  permissions(memberId: MemberId): Promise<readonly WorkspacePermission[]>
  activeAdminIds(): Promise<MemberId[]>
  save(member: Member): Promise<void>
}

export type InvitationRepository = {
  get(invitationId: string): Promise<Invitation | undefined>
  findOpen(email: string): Promise<Invitation | undefined>
  awaitsDomainVerification(): Promise<boolean>
  add(invitation: Invitation): Promise<void>
  save(invitation: Invitation): Promise<void>
}

export type MemberAccess = {
  revoke(memberId: MemberId): Promise<void>
  stopTurnsLater(change: { memberId: MemberId; actorId: MemberId }): Promise<void>
}

export type WorkspaceEventLog = {
  record(event: { type: string; actorId: MemberId; payload: object }): Promise<void>
}

export type ChatRuntimeRepository = {
  remove(chatId: ChatId): Promise<void>
  stop(chatId: ChatId): Promise<void>
}

export type GitHubRepositories = {
  branches(fullName: string): Promise<string[]>
}

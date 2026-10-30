import type {
  ChatId,
  ChatPermission,
  ChatVisibility,
  DevLoopSettings,
  MemberId,
  ProjectId,
  SetupCommand,
  WorkspaceId,
  WorkspacePermission,
} from '@spyria/kernel'
import type { Chat } from '../domain/chat.ts'
import type { GitHubRepository, GitHubSettingsInput, GitHubSettingsView } from '../domain/github.ts'
import type { Name } from '../domain/name.ts'
import type { ChatsPolicy } from '../domain/project.ts'
import type { SsoSettingsInput, SsoSettingsView } from '../domain/sso.ts'

type Command<Input> = (input: Input & { workspaceId: WorkspaceId }) => Promise<string>

export type WorkspaceCommands = {
  createProject: Command<{ name: Name }>
  createChat: Command<{ type: Chat['type']; visibility?: ChatVisibility; name: Name; projectId: ProjectId | null }>
  moveChat: Command<{ chatId: ChatId; projectId: ProjectId | null }>
  archiveChat: Command<{ chatId: ChatId }>
  archiveProject: Command<{ projectId: ProjectId; chatsPolicy: ChatsPolicy }>
  renameChat: Command<{ chatId: ChatId; name: Name }>
  changeVisibility: Command<{ chatId: ChatId; visibility: ChatVisibility }>
  joinChat: Command<{ chatId: ChatId }>
  leaveChat: Command<{ chatId: ChatId }>
  renameProject: Command<{ projectId: ProjectId; name: Name }>
  createWorkspace: Command<{ name: Name }>
  inviteMember: Command<{ email: string; role: string }>
  revokeInvite: Command<{ invitationId: string }>
  changeMemberRole: Command<{ memberId: MemberId; role: string }>
  removeMember: Command<{ memberId: MemberId }>
  transferChat: Command<{ chatId: ChatId; ownerId: MemberId }>
  createChatRole: Command<{ name: string; permissions: readonly ChatPermission[] }>
  updateChatRole: Command<{ roleId: string; name: string; permissions: readonly ChatPermission[] }>
  deleteChatRole: Command<{ roleId: string }>
  createWorkspaceRole: Command<{ name: string; permissions: readonly WorkspacePermission[] }>
  updateWorkspaceRole: Command<{ roleId: string; name: string; permissions: readonly WorkspacePermission[] }>
  deleteWorkspaceRole: Command<{ roleId: string }>
  deleteWorkspace: Command<{ confirmation: 'DELETE' }>
  setDevLoop: Command<{ settings: DevLoopSettings | null }>
  setSetupCommands: Command<{ commands: readonly SetupCommand[] }>
  listCheckNames: (input: { workspaceId: WorkspaceId; repository: string; branch: string }) => Promise<string[]>
  readSsoSettings: (input: { workspaceId: WorkspaceId }) => Promise<SsoSettingsView | null>
  saveSsoSettings: (input: SsoSettingsInput & { workspaceId: WorkspaceId }) => Promise<SsoSettingsView | null>
  sendDomainVerification: (input: {
    workspaceId: WorkspaceId
    domain: string
    email: string
  }) => Promise<SsoSettingsView | null>
  readGitHubSettings: (input: { workspaceId: WorkspaceId }) => Promise<GitHubSettingsView | null>
  isGitHubConfigured: (input: { workspaceId: WorkspaceId }) => Promise<boolean>
  saveGitHubSettings: (input: GitHubSettingsInput & { workspaceId: WorkspaceId }) => Promise<GitHubSettingsView | null>
  startGitHubAppCreation: (input: {
    workspaceId: WorkspaceId
    organization: string
  }) => Promise<{ formAction: string; manifest: string }>
  listRepositories: (input: { workspaceId: WorkspaceId }) => Promise<GitHubRepository[]>
  listBranches: (input: { workspaceId: WorkspaceId; repository: string }) => Promise<string[]>
  createDevChat: Command<{
    name: Name
    projectId: ProjectId | null
    repository: string
    baseBranch: string
    visibility?: ChatVisibility
  }>
}

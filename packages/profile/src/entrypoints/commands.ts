import type { CredentialId, MemberId, WorkspaceId } from '@spyria/kernel'
import type { Avatar } from '../domain/avatar.ts'
import type { DisplayName } from '../domain/display-name.ts'
import type { GitHubConnection } from '../domain/github-connection.ts'
import type { Secret } from '../domain/secret.ts'
import type { ConnectionInput } from '../domain/workspace-connection.ts'

type Command<Input> = (input: Input & { workspaceId: WorkspaceId }) => Promise<unknown>

type ConnectionCommand<Input> = Command<Input & { connectionId: string }>

export type ProfileCommands = {
  addWorkspaceConnection: Command<ConnectionInput>
  editWorkspaceConnection: ConnectionCommand<ConnectionInput>
  removeWorkspaceConnection: ConnectionCommand<object>
  allowConnectionTools: ConnectionCommand<{ allowedTools: string[] }>
  restrictConnectionMember: ConnectionCommand<{ memberId: MemberId; allowedTools: string[] | null }>
  renameMember: Command<{ name: DisplayName }>
  changeAvatar: Command<{ avatar: Avatar | null }>
  removeLlmCredential: Command<{ credentialId: CredentialId }>
  connectTool: Command<{ tool: string }>
  disconnectTool: Command<{ tool: string }>
  availableTools: (input: { workspaceId: WorkspaceId }) => Promise<string[]>
  addLlmCredential: Command<{ provider: string; secret: Secret }>
  readGitHubConnection: (input: { workspaceId: WorkspaceId }) => Promise<GitHubConnection>
  connectGitHub: (input: { workspaceId: WorkspaceId }) => Promise<GitHubConnection>
  disconnectGitHub: Command<object>
}

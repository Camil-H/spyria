import type { AiProviderAllowList, CredentialId, ToolApproval, WorkspaceId } from '@spyria/kernel'
import type { ActiveSession } from '../domain/active-session.ts'
import type { Avatar } from '../domain/avatar.ts'
import type { DisplayName } from '../domain/display-name.ts'
import type { GitHubConnection } from '../domain/github-connection.ts'
import type { Secret } from '../domain/secret.ts'
import type { AccessInput, ConnectionInput, ToolMarking } from '../domain/workspace-connection.ts'

type Command<Input> = (input: Input & { workspaceId: WorkspaceId }) => Promise<unknown>

type ConnectionCommand<Input> = Command<Input & { connectionId: string }>

export type ProfileCommands = {
  addWorkspaceConnection: Command<ConnectionInput>
  editWorkspaceConnection: ConnectionCommand<Omit<ConnectionInput, 'signIn'>>
  removeWorkspaceConnection: ConnectionCommand<object>
  reviewConnectionTools: ConnectionCommand<{ markings: ToolMarking[] }>
  setConnectionAccess: ConnectionCommand<AccessInput>
  setConnectionCodeMode: ConnectionCommand<{ isOn: boolean }>
  setToolApproval: ConnectionCommand<{ tool: string | null; approval: ToolApproval | null }>
  renameMember: Command<{ name: DisplayName }>
  changeAvatar: Command<{ avatar: Avatar | null }>
  removeLlmCredential: Command<{ credentialId: CredentialId }>
  setAiProviders: Command<{ allowList: AiProviderAllowList | null }>
  connectTool: Command<{ tool: string }>
  disconnectTool: Command<{ tool: string }>
  checkTools: Command<object>
  addLlmCredential: Command<{ provider: string; secret: Secret }>
  readGitHubConnection: (input: { workspaceId: WorkspaceId }) => Promise<GitHubConnection>
  connectGitHub: (input: { workspaceId: WorkspaceId }) => Promise<GitHubConnection>
  disconnectGitHub: Command<object>
  readActiveSessions: (input: { workspaceId: WorkspaceId }) => Promise<readonly ActiveSession[]>
  signOutEverywhere: Command<object>
}

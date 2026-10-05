import type { CredentialId, WorkspaceId } from '@hq/kernel'
import type { DisplayName } from '../domain/display-name.ts'
import type { Secret } from '../domain/secret.ts'

type Command<Input> = (input: Input & { workspaceId: WorkspaceId }) => Promise<unknown>

export type ProfileCommands = {
  renameMember: Command<{ name: DisplayName }>
  removeLlmCredential: Command<{ credentialId: CredentialId }>
  connectTool: Command<{ tool: string }>
  disconnectTool: Command<{ tool: string }>
  addLlmCredential: Command<{ provider: string; secret: Secret }>
}

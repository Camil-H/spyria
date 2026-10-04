import type { WorkspaceId } from '@hq/kernel'
import { addLlmCredential } from '../operations/add-llm-credential.ts'
import { connectTool } from '../operations/connect-tool.ts'
import { disconnectTool } from '../operations/disconnect-tool.ts'
import { removeLlmCredential } from '../operations/remove-llm-credential.ts'
import { renameMember } from '../operations/rename-member.ts'

export const profileOperations = {
  addLlmCredential,
  connectTool,
  disconnectTool,
  removeLlmCredential,
  renameMember,
}

type ProfileOperations = typeof profileOperations

export type ProfileCommands = {
  [Name in keyof ProfileOperations]: (
    input: Parameters<ProfileOperations[Name]>[1] & { workspaceId: WorkspaceId },
  ) => ReturnType<ProfileOperations[Name]>
}

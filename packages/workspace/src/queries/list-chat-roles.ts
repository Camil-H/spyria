import type { Snapshot } from '@hq/db'
import type { WorkspaceId } from '@hq/kernel'

export const listBuiltInChatRoles = (workspaceId: WorkspaceId) => (snapshot: Snapshot) =>
  snapshot.chatRoles.filter((role) => role.workspaceId === workspaceId && role.builtIn)

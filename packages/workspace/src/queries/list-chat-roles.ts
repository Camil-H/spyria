import type { Snapshot } from '@hq/db'
import type { WorkspaceId } from '@hq/kernel'

export const listChatRoles = (workspaceId: WorkspaceId) => (snapshot: Snapshot) =>
  snapshot.chatRoles
    .filter((role) => role.workspaceId === workspaceId)
    .toSorted(
      (first, second) =>
        Number(second.builtIn) - Number(first.builtIn) ||
        second.permissions.length - first.permissions.length ||
        first.name.localeCompare(second.name),
    )

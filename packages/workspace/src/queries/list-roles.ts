import type { Snapshot } from '@hq/db'
import type { WorkspaceId } from '@hq/kernel'

type ListedRole = { workspaceId: WorkspaceId; name: string; permissions: readonly string[]; builtIn: boolean }

const rolesOf = <Role extends ListedRole>(roles: readonly Role[], workspaceId: WorkspaceId) =>
  roles
    .filter((role) => role.workspaceId === workspaceId)
    .toSorted(
      (first, second) =>
        Number(second.builtIn) - Number(first.builtIn) ||
        second.permissions.length - first.permissions.length ||
        first.name.localeCompare(second.name),
    )

export const listChatRoles = (workspaceId: WorkspaceId) => (snapshot: Snapshot) =>
  rolesOf(snapshot.chatRoles, workspaceId)

export const listWorkspaceRoles = (workspaceId: WorkspaceId) => (snapshot: Snapshot) =>
  rolesOf(snapshot.workspaceRoles, workspaceId)

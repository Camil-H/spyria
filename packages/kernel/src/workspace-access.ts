import { DomainError, errorKind } from './errors.ts'
import type { MemberId } from './ids.ts'

export const workspacePermissions = [
  'members.invite',
  'members.manage',
  'roles.manage',
  'sso.manage',
  'github.manage',
  'tools.manage',
  'providers.manage',
  'runtimes.manage',
  'costs.view',
  'budgets.manage',
  'audit.view',
] as const
export type WorkspacePermission = (typeof workspacePermissions)[number]
export type WorkspaceRole = Readonly<{ id: string; name: string; permissions: readonly WorkspacePermission[] }>

export const workspacePermissionLabels: Record<WorkspacePermission, string> = {
  'members.invite': 'Invite members',
  'members.manage': 'Change roles and remove members',
  'roles.manage': 'Manage roles',
  'sso.manage': 'Set up SSO',
  'github.manage': 'Connect GitHub',
  'tools.manage': 'Manage shared MCP tools',
  'providers.manage': 'Manage AI providers and models',
  'runtimes.manage': 'Manage runtime hosts and local sessions',
  'costs.view': 'View costs',
  'budgets.manage': 'Manage budgets',
  'audit.view': 'View the audit log',
}

export const adminRoleId = 'admin'
export const memberRoleId = 'member'

export const builtInWorkspaceRoles: readonly WorkspaceRole[] = [
  { id: adminRoleId, name: 'Admin', permissions: workspacePermissions },
  { id: memberRoleId, name: 'Member', permissions: [] },
]

export const canGrantWorkspaceRole = (
  ownPermissions: readonly WorkspacePermission[],
  role: { permissions: readonly WorkspacePermission[] },
) => role.permissions.every((permission) => ownPermissions.includes(permission))

export const MissingWorkspacePermission = errorKind(
  'missing_workspace_permission',
  (permission: WorkspacePermission) =>
    `Your workspace role does not allow this: ${workspacePermissionLabels[permission]}`,
  DomainError,
)

export const requirePermissionIn = (permissions: readonly WorkspacePermission[], permission: WorkspacePermission) => {
  if (!permissions.includes(permission)) throw new MissingWorkspacePermission(permission)
  return permissions
}

export const requireWorkspacePermission = async (
  members: { permissions(memberId: MemberId): Promise<readonly WorkspacePermission[]> },
  memberId: MemberId,
  permission: WorkspacePermission,
) => requirePermissionIn(await members.permissions(memberId), permission)

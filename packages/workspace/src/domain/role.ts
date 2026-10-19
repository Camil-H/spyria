import {
  builtInChatRoles,
  builtInWorkspaceRoles,
  type ChatPermission,
  type ChatRole,
  canGrantWorkspaceRole,
  chatPermissions,
  type WorkspacePermission,
  type WorkspaceRole,
  workspacePermissions,
} from '@spyria/kernel'
import {
  CustomRoleNotFound,
  InvalidRoleName,
  ReservedRoleName,
  RoleInUse,
  RoleNameTaken,
  RoleNotGrantable,
  UnknownChatPermission,
  UnknownWorkspacePermission,
  WorkspaceRoleNotFound,
} from './errors.ts'

export type StoredChatRole = ChatRole & { builtIn: boolean }
export type StoredWorkspaceRole = WorkspaceRole & { builtIn: boolean }
export type RoleHolders = Readonly<{ memberCount: number; chatCount: number }>
export type WorkspaceRoleHolders = Readonly<{ memberCount: number; inviteCount: number }>
type RoleInput = { id: string; name: string; permissions: readonly string[] }

const maximumRoleNameLength = 40

const isSameName = (first: string, second: string) => first.toLowerCase() === second.toLowerCase()
const countLabelOf = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`

const customRoleOf = <Permission extends string>(
  input: RoleInput,
  kind: {
    builtInRoles: readonly { name: string }[]
    permissions: readonly Permission[]
    alwaysGranted: readonly Permission[]
    refuseUnknown: (permission: string) => never
  },
) => {
  const name = input.name.trim()
  if (name.length === 0 || name.length > maximumRoleNameLength) throw new InvalidRoleName()
  if (kind.builtInRoles.some((role) => isSameName(role.name, name))) throw new ReservedRoleName(name)
  const unknownPermission = input.permissions.find((permission) => !kind.permissions.includes(permission as Permission))
  if (unknownPermission !== undefined) kind.refuseUnknown(unknownPermission)
  return {
    id: input.id,
    name,
    permissions: kind.permissions.filter(
      (permission) => kind.alwaysGranted.includes(permission) || input.permissions.includes(permission),
    ),
  }
}

export const customChatRoleOf = (input: RoleInput): ChatRole =>
  customRoleOf<ChatPermission>(input, {
    builtInRoles: builtInChatRoles,
    permissions: chatPermissions,
    alwaysGranted: ['chat.read'],
    refuseUnknown: (permission) => {
      throw new UnknownChatPermission(permission)
    },
  })

export const customWorkspaceRoleOf = (input: RoleInput): WorkspaceRole =>
  customRoleOf<WorkspacePermission>(input, {
    builtInRoles: builtInWorkspaceRoles,
    permissions: workspacePermissions,
    alwaysGranted: [],
    refuseUnknown: (permission) => {
      throw new UnknownWorkspacePermission(permission)
    },
  })

export const requireUniqueRoleName = (
  role: { id: string; name: string },
  roles: readonly { id: string; name: string }[],
) => {
  if (roles.some((other) => other.id !== role.id && isSameName(other.name, role.name)))
    throw new RoleNameTaken(role.name)
}

export const requireCustomRole = <Role extends { builtIn: boolean }>(role: Role | undefined, roleId: string) => {
  if (!role || role.builtIn) throw new CustomRoleNotFound(roleId)
  return role
}

export const requireUnheldRole = (role: ChatRole, holders: RoleHolders) => {
  if (holders.memberCount > 0)
    throw new RoleInUse(
      role.name,
      `${countLabelOf(holders.memberCount, 'member')} in ${countLabelOf(holders.chatCount, 'chat')}`,
    )
}

export const requireUnheldWorkspaceRole = (role: WorkspaceRole, holders: WorkspaceRoleHolders) => {
  if (holders.memberCount + holders.inviteCount > 0)
    throw new RoleInUse(
      role.name,
      [
        holders.memberCount > 0 && countLabelOf(holders.memberCount, 'member'),
        holders.inviteCount > 0 && countLabelOf(holders.inviteCount, 'pending invite'),
      ]
        .filter(Boolean)
        .join(' and '),
    )
}

export const requireGrantableRole = (
  actorPermissions: readonly WorkspacePermission[],
  role: WorkspaceRole | undefined,
  roleId: string,
) => {
  if (!role) throw new WorkspaceRoleNotFound(roleId)
  if (!canGrantWorkspaceRole(actorPermissions, role)) throw new RoleNotGrantable(role.name)
  return role
}

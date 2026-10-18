import { builtInChatRoles, type ChatPermission, type ChatRole, chatPermissions } from '@hq/kernel'
import {
  CustomRoleNotFound,
  InvalidRoleName,
  ReservedRoleName,
  RoleInUse,
  RoleNameTaken,
  UnknownChatPermission,
} from './errors.ts'

export type StoredChatRole = ChatRole & { builtIn: boolean }
export type RoleHolders = Readonly<{ memberCount: number; chatCount: number }>

const maximumRoleNameLength = 40

const isSameName = (first: string, second: string) => first.toLowerCase() === second.toLowerCase()
const isChatPermission = (permission: string): permission is ChatPermission =>
  chatPermissions.includes(permission as ChatPermission)
const countLabelOf = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`

export const customChatRoleOf = (input: { id: string; name: string; permissions: readonly string[] }): ChatRole => {
  const name = input.name.trim()
  if (name.length === 0 || name.length > maximumRoleNameLength) throw new InvalidRoleName()
  if (builtInChatRoles.some((role) => isSameName(role.name, name))) throw new ReservedRoleName(name)
  const unknownPermission = input.permissions.find((permission) => !isChatPermission(permission))
  if (unknownPermission !== undefined) throw new UnknownChatPermission(unknownPermission)
  return {
    id: input.id,
    name,
    permissions: chatPermissions.filter(
      (permission) => permission === 'chat.read' || input.permissions.includes(permission),
    ),
  }
}

export const requireUniqueRoleName = (role: ChatRole, roles: readonly ChatRole[]) => {
  if (roles.some((other) => other.id !== role.id && isSameName(other.name, role.name)))
    throw new RoleNameTaken(role.name)
}

export const requireCustomRole = (role: StoredChatRole | undefined, roleId: string) => {
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

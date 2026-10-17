import { DomainError, errorKind } from './errors.ts'
import type { ChatId, MemberId } from './ids.ts'

export type ChatPermission =
  | 'chat.read'
  | 'chat.post'
  | 'session.configure'
  | 'tools.manage'
  | 'members.invite'
  | 'members.manage'
  | 'chat.admin'
export type ChatVisibility = 'public' | 'private'
export type ChatRoleId = 'owner' | 'editor' | 'prompter' | 'reader'
export type ChatRole = Readonly<{ id: string; name: string; permissions: readonly ChatPermission[] }>

export const builtInChatRoles: readonly (ChatRole & { id: ChatRoleId })[] = [
  {
    id: 'owner',
    name: 'Owner',
    permissions: [
      'chat.read',
      'chat.post',
      'session.configure',
      'tools.manage',
      'members.invite',
      'members.manage',
      'chat.admin',
    ],
  },
  { id: 'editor', name: 'Editor', permissions: ['chat.read', 'chat.post', 'session.configure', 'members.invite'] },
  { id: 'prompter', name: 'Prompter', permissions: ['chat.read', 'chat.post'] },
  { id: 'reader', name: 'Reader', permissions: ['chat.read'] },
]

export const visibilityOf = (type: 'channel' | 'runtime'): ChatVisibility => (type === 'channel' ? 'public' : 'private')

export const permissionsOf = (
  chat: { visibility: ChatVisibility },
  role: { permissions: readonly ChatPermission[] } | undefined,
): readonly ChatPermission[] => role?.permissions ?? (chat.visibility === 'public' ? ['chat.read', 'chat.post'] : [])

export const can = (permissions: readonly ChatPermission[], permission: ChatPermission) =>
  permissions.includes(permission)

export const canGrant = (ownPermissions: readonly ChatPermission[], role: { permissions: readonly ChatPermission[] }) =>
  role.permissions.every((permission) => can(ownPermissions, permission))

export const isRoleAllowedIn = (
  chat: { visibility: ChatVisibility },
  role: { permissions: readonly ChatPermission[] },
) => canGrant(role.permissions, { permissions: permissionsOf(chat, undefined) })

export const MissingChatPermission = errorKind(
  'missing_chat_permission',
  (permission: ChatPermission) => `You need the ${permission} permission on this chat`,
  DomainError,
)

export const requireChatPermission = async (
  chats: { permissions(chatId: ChatId, memberId: MemberId): Promise<readonly ChatPermission[]> },
  chatId: ChatId,
  memberId: MemberId,
  permission: ChatPermission,
) => {
  if (!can(await chats.permissions(chatId, memberId), permission)) throw new MissingChatPermission(permission)
}

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

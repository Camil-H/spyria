import { type ChatPermission, type ChatRole, canGrant, isRoleAllowedIn, type MemberId } from '@spyria/kernel'
import {
  NotParticipant,
  OwnerRoleNotAssignable,
  OwnerStays,
  PublicChatOpenToAll,
  RoleAboveOwn,
  RoleNotFound,
} from './errors.ts'
import type { ConversationChat } from './message.ts'

export const requireParticipant = (participantRoleId: string | undefined) => {
  if (!participantRoleId) throw new NotParticipant()
}

export const requireNonOwner = (chat: ConversationChat, memberId: MemberId) => {
  if (chat.ownerId === memberId) throw new OwnerStays()
}

export const requireAssignableRole = (
  chat: ConversationChat,
  actorPermissions: readonly ChatPermission[],
  roleId: string,
  role: ChatRole | undefined,
) => {
  if (roleId === 'owner') throw new OwnerRoleNotAssignable()
  if (!role) throw new RoleNotFound(roleId)
  if (!canGrant(actorPermissions, role)) throw new RoleAboveOwn()
  if (!isRoleAllowedIn(chat, role)) throw new PublicChatOpenToAll()
}

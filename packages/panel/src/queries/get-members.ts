import { chatPermissionsIn, findChat, inChat, memberNamesIn, type Snapshot } from '@hq/db'
import { type ChatId, can, canGrant, isRoleAllowedIn, type MemberId, type WorkspaceId } from '@hq/kernel'

export const getMembers = (workspaceId: WorkspaceId, chatId: ChatId, viewerId: MemberId) => (snapshot: Snapshot) => {
  const chat = findChat(snapshot, workspaceId, chatId)
  if (!chat) return undefined
  const memberName = memberNamesIn(snapshot, workspaceId)
  const permissions = chatPermissionsIn(snapshot, workspaceId, viewerId)(chat)
  const roles = snapshot.chatRoles
    .filter((role) => role.workspaceId === workspaceId)
    .toSorted((first, second) => second.permissions.length - first.permissions.length)
  const assignableRoles = roles.filter((role) => role.id !== 'owner' && isRoleAllowedIn(chat, role))
  const isOwner = (memberId: MemberId) => Number(memberId === chat.ownerId)
  const participants = snapshot.chatMembers.filter(inChat(workspaceId, chatId))
  const participantIds = new Set(participants.map((participant) => participant.memberId))
  return {
    members: participants
      .toSorted((first, second) => isOwner(second.memberId) - isOwner(first.memberId))
      .map(({ memberId, roleId }) => ({
        memberId,
        roleId,
        role: roles.find((role) => role.id === roleId)?.name ?? roleId,
        name: memberName(memberId),
        isOwner: memberId === chat.ownerId,
      })),
    canManage: can(permissions, 'members.manage'),
    canRemove: can(permissions, 'members.manage') && chat.visibility === 'private',
    canLeave: participantIds.has(viewerId) && viewerId !== chat.ownerId,
    assignableRoles,
    invitableRoles: can(permissions, 'members.invite')
      ? assignableRoles.filter((role) => canGrant(permissions, role))
      : [],
    invitees: snapshot.memberships
      .filter((membership) => membership.workspaceId === workspaceId && !participantIds.has(membership.memberId))
      .map(({ memberId }) => ({ memberId, name: memberName(memberId) })),
  }
}

import { findChat, inChat, memberNamesIn, type Snapshot } from '@hq/db'
import type { ChatId, WorkspaceId } from '@hq/kernel'

export const getMembers = (workspaceId: WorkspaceId, chatId: ChatId) => (snapshot: Snapshot) => {
  const chat = findChat(snapshot, workspaceId, chatId)
  if (!chat) return []
  const memberName = memberNamesIn(snapshot, workspaceId)
  const roleNameOf = (roleId: string) =>
    snapshot.chatRoles.find((role) => role.workspaceId === workspaceId && role.id === roleId)?.name ?? roleId
  const isOwner = (memberId: string) => Number(memberId === chat.ownerId)
  return snapshot.chatMembers
    .filter(inChat(workspaceId, chatId))
    .toSorted((first, second) => isOwner(second.memberId) - isOwner(first.memberId))
    .map(({ memberId, roleId }) => ({ memberId, role: roleNameOf(roleId), name: memberName(memberId) }))
}

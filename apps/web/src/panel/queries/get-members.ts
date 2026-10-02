import { findChat, inChat, memberName, type Snapshot } from '@hq/db'
import type { ChatId, WorkspaceId } from '@hq/kernel'

export const getMembers = (workspaceId: WorkspaceId, chatId: ChatId) => (snapshot: Snapshot) => {
  const chat = findChat(snapshot, workspaceId, chatId)
  if (!chat) return []
  const explicitMembers = snapshot.chatMembers.filter(
    (row) => inChat(workspaceId, chatId)(row) && row.memberId !== chat.ownerId,
  )
  return [{ memberId: chat.ownerId, role: 'Owner' }, ...explicitMembers].map(({ memberId, role }) => ({
    memberId,
    role,
    name: memberName(snapshot, memberId),
  }))
}

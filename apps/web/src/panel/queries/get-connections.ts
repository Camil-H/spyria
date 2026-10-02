import { findChat, memberName, type Snapshot } from '@hq/db'
import type { ChatId, WorkspaceId } from '@hq/kernel'

export const getConnections = (workspaceId: WorkspaceId, chatId: ChatId) => (snapshot: Snapshot) => {
  const chat = findChat(snapshot, workspaceId, chatId)
  if (!chat) return null
  return {
    ownerName: memberName(snapshot, chat.ownerId),
    connections: snapshot.toolConnections.filter(
      (connection) => connection.workspaceId === workspaceId && connection.memberId === chat.ownerId,
    ),
  }
}

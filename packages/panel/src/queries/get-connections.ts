import { findChat, memberToolsIn, ownedBy, type Snapshot, workspaceConnectionsIn } from '@hq/db'
import type { ChatId, WorkspaceId } from '@hq/kernel'

export const getConnections = (workspaceId: WorkspaceId, chatId: ChatId) => (snapshot: Snapshot) => {
  const chat = findChat(snapshot, workspaceId, chatId)
  if (!chat) return null
  return {
    workspace: workspaceConnectionsIn(snapshot, workspaceId).map((connection) => ({
      id: connection.id,
      name: connection.name,
      tools: memberToolsIn(snapshot, connection, chat.ownerId),
    })),
    personal: snapshot.toolConnections
      .filter(ownedBy(workspaceId, chat.ownerId))
      .map(({ tool, status }) => ({ tool, status })),
  }
}

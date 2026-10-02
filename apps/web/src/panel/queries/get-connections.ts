import { findChat, ownedBy, type Snapshot } from '@hq/db'
import type { ChatId, WorkspaceId } from '@hq/kernel'

export const getConnections = (workspaceId: WorkspaceId, chatId: ChatId) => (snapshot: Snapshot) => {
  const chat = findChat(snapshot, workspaceId, chatId)
  if (!chat) return null
  const ownedByChatOwner = ownedBy(workspaceId, chat.ownerId)
  return {
    workspace: snapshot.workspaceConnections.filter(ownedByChatOwner).map(({ tool, access }) => ({ tool, access })),
    personal: snapshot.toolConnections.filter(ownedByChatOwner).map(({ tool, status }) => ({ tool, status })),
  }
}

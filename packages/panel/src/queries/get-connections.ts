import { type Snapshot, usableConnectionsIn } from '@spyria/db'
import type { ChatId, WorkspaceId } from '@spyria/kernel'
import { panelChatIn } from './panel-chat.ts'

export const getConnections = (workspaceId: WorkspaceId, chatId: ChatId) => (snapshot: Snapshot) => {
  const chat = panelChatIn(snapshot, workspaceId, chatId)
  return chat ? usableConnectionsIn(snapshot, workspaceId, chat.ownerId) : null
}

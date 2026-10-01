import type { Snapshot } from '@hq/db'
import type { ChatId, WorkspaceId } from '@hq/kernel'

export const getChatSummary = (workspaceId: WorkspaceId, chatId: ChatId) => (snapshot: Snapshot) => {
  const chat = snapshot.chats.find(
    (candidate) => candidate.id === chatId && candidate.workspaceId === workspaceId && !candidate.archived,
  )
  return chat ? { id: chat.id, name: chat.name, type: chat.type } : null
}

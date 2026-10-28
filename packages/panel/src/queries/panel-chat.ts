import { chatIn, type Snapshot } from '@spyria/db'
import type { ChatId, WorkspaceId } from '@spyria/kernel'
import { showsPanel } from '../domain/chat.ts'

export const panelChatIn = (snapshot: Snapshot, workspaceId: WorkspaceId, chatId: ChatId) => {
  const chat = chatIn(snapshot, workspaceId, chatId)
  return chat && showsPanel(chat) ? chat : undefined
}

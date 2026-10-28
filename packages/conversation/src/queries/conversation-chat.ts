import { chatIn, type Snapshot } from '@spyria/db'
import type { ChatId, WorkspaceId } from '@spyria/kernel'
import { showsConversation } from '../domain/message.ts'

export const conversationChatIn = (snapshot: Snapshot, workspaceId: WorkspaceId, chatId: ChatId) => {
  const chat = chatIn(snapshot, workspaceId, chatId)
  return chat && showsConversation(chat) ? chat : undefined
}

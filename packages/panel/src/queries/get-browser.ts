import { inChat, type Snapshot } from '@spyria/db'
import type { ChatId, WorkspaceId } from '@spyria/kernel'

export const getOpenedPages = (workspaceId: WorkspaceId, chatId: ChatId) => (snapshot: Snapshot) =>
  snapshot.browserPages.filter(inChat(workspaceId, chatId)).toSorted((a, b) => b.openedAt.localeCompare(a.openedAt))

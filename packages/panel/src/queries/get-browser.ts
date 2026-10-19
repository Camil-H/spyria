import { inChat, type Snapshot } from '@spyria/db'
import type { ChatId, WorkspaceId } from '@spyria/kernel'

export const getBrowser = (workspaceId: WorkspaceId, chatId: ChatId) => (snapshot: Snapshot) =>
  snapshot.browserPages.find(inChat(workspaceId, chatId)) ?? null

import { inChat, type Snapshot } from '@spyria/db'
import type { ChatId, WorkspaceId } from '@spyria/kernel'

export const getSources = (workspaceId: WorkspaceId, chatId: ChatId) => (snapshot: Snapshot) =>
  snapshot.sources.filter(inChat(workspaceId, chatId))

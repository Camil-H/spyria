import { inChat, type Snapshot } from '@hq/db'
import type { ChatId, WorkspaceId } from '@hq/kernel'

export const getSources = (workspaceId: WorkspaceId, chatId: ChatId) => (snapshot: Snapshot) =>
  snapshot.sources.filter(inChat(workspaceId, chatId))

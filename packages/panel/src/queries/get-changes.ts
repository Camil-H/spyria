import { inChat, type Snapshot } from '@hq/db'
import type { ChatId, WorkspaceId } from '@hq/kernel'

export const getChanges = (workspaceId: WorkspaceId, chatId: ChatId) => (snapshot: Snapshot) =>
  snapshot.changes.filter(inChat(workspaceId, chatId))

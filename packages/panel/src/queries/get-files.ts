import { inChat, type Snapshot } from '@hq/db'
import type { ChatId, WorkspaceId } from '@hq/kernel'

export const getFiles = (workspaceId: WorkspaceId, chatId: ChatId) => (snapshot: Snapshot) =>
  snapshot.files.filter(inChat(workspaceId, chatId)).sort((first, second) => first.path.localeCompare(second.path))

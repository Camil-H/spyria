import { type Snapshot, usableConnectionsIn } from '@spyria/db'
import type { ChatId, MemberId, WorkspaceId } from '@spyria/kernel'
import { panelChatIn } from './panel-chat.ts'

export const getConnections = (workspaceId: WorkspaceId, chatId: ChatId, viewerId: MemberId) => (snapshot: Snapshot) =>
  panelChatIn(snapshot, workspaceId, chatId) ? usableConnectionsIn(snapshot, workspaceId, viewerId) : null

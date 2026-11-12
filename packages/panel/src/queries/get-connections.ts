import { chatPermissionsIn, type Snapshot, usableConnectionsIn } from '@spyria/db'
import { type ChatId, can, type MemberId, type WorkspaceId } from '@spyria/kernel'
import { panelChatIn } from './panel-chat.ts'

export const getConnections =
  (workspaceId: WorkspaceId, chatId: ChatId, viewerId: MemberId) => (snapshot: Snapshot) => {
    const chat = panelChatIn(snapshot, workspaceId, chatId)
    if (!chat) return null
    return {
      connections: usableConnectionsIn(snapshot, workspaceId, viewerId).map((connection) => ({
        ...connection,
        isOn: !chat.toolServersOff.includes(connection.gatewayName),
      })),
      canSwitch: can(chatPermissionsIn(snapshot, workspaceId, viewerId)(chat), 'tools.manage'),
    }
  }

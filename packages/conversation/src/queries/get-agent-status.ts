import { findChat, type Snapshot } from '@spyria/db'
import type { ChatId, WorkspaceId } from '@spyria/kernel'
import { agentStatusOf } from '../domain/agent-status.ts'

export const getAgentStatus = (workspaceId: WorkspaceId, chatId: ChatId) => (snapshot: Snapshot) => {
  const chat = findChat(snapshot, workspaceId, chatId)
  if (chat?.type !== 'runtime') return null
  return agentStatusOf({
    isTurnActive: chat.agentTurnMessageId !== null,
    latestActivity: snapshot.latestAgentActivity.find(
      (message) => message.workspaceId === workspaceId && message.chatId === chatId,
    ),
  })
}

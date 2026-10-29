import type { Snapshot } from '@spyria/db'
import type { ChatId, WorkspaceId } from '@spyria/kernel'
import { agentStatusOf } from '../domain/agent-status.ts'
import { conversationChatIn } from './conversation-chat.ts'

export const getAgentStatus = (workspaceId: WorkspaceId, chatId: ChatId) => (snapshot: Snapshot) => {
  const chat = conversationChatIn(snapshot, workspaceId, chatId)
  if (chat?.type !== 'runtime') return null
  return agentStatusOf({
    isTurnActive: chat.agentTurnMessageId !== null,
    isRuntimeAsleep: snapshot.runtimes.some(
      (runtime) =>
        runtime.workspaceId === workspaceId &&
        runtime.chatId === chatId &&
        (runtime.state === 'stopping' || runtime.state === 'stopped'),
    ),
    latestActivity: snapshot.latestAgentActivity.find(
      (message) => message.workspaceId === workspaceId && message.chatId === chatId,
    ),
  })
}

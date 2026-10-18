import { findChat, inChat, type Snapshot } from '@hq/db'
import type { ChatId, WorkspaceId } from '@hq/kernel'

export const getTerminal = (workspaceId: WorkspaceId, chatId: ChatId) => (snapshot: Snapshot) => {
  const turnPromptId = findChat(snapshot, workspaceId, chatId)?.agentTurnMessageId ?? null
  return snapshot.messages
    .filter((message) => inChat(workspaceId, chatId)(message) && message.step?.type === 'command')
    .sort((first, second) => first.seq - second.seq)
    .map(({ id, step, replyToId }) => {
      const exitCode = typeof step?.exitCode === 'number' ? step.exitCode : null
      return {
        stepId: id,
        command: String(step?.command ?? ''),
        output: String(step?.output ?? ''),
        exitCode,
        isRunning: exitCode === null && turnPromptId !== null && replyToId === turnPromptId,
      }
    })
}

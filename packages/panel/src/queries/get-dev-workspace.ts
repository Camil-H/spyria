import { inChat, type MessageStep, type Snapshot } from '@spyria/db'
import type { ChatId, WorkspaceId } from '@spyria/kernel'
import { panelChatIn } from './panel-chat.ts'

const asleepStates = ['stopping', 'stopped']

const canChangeFiles = (step: MessageStep | null) =>
  (step?.type === 'command' && typeof step.exitCode === 'number') ||
  (step?.type === 'file' && step.operation !== 'read' && Number(step.added) + Number(step.removed) > 0) ||
  step?.type === 'pull_request'

export const getDevWorkspace = (workspaceId: WorkspaceId, chatId: ChatId) => (snapshot: Snapshot) => {
  const runtimeState = snapshot.runtimes.find(inChat(workspaceId, chatId))?.state ?? null
  const fileChangingSteps = snapshot.messages.filter(
    (message) => inChat(workspaceId, chatId)(message) && message.kind === 'step' && canChangeFiles(message.step),
  ).length
  return {
    isAsleep: runtimeState !== null && asleepStates.includes(runtimeState),
    refreshKey: [
      runtimeState,
      panelChatIn(snapshot, workspaceId, chatId)?.agentTurnMessageId ?? null,
      fileChangingSteps,
    ].join('|'),
  }
}

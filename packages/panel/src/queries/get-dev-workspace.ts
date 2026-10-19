import { findChat, inChat, type Snapshot } from '@spyria/db'
import type { ChatId, WorkspaceId } from '@spyria/kernel'

const asleepStates = ['stopping', 'stopped']

export const getDevWorkspace = (workspaceId: WorkspaceId, chatId: ChatId) => (snapshot: Snapshot) => {
  const runtimeState = snapshot.runtimes.find(inChat(workspaceId, chatId))?.state ?? null
  const steps = snapshot.messages.filter((message) => inChat(workspaceId, chatId)(message) && message.kind === 'step')
  const finishedCommands = steps.filter((message) => typeof message.step?.exitCode === 'number').length
  return {
    isAsleep: runtimeState !== null && asleepStates.includes(runtimeState),
    refreshKey: [
      runtimeState,
      findChat(snapshot, workspaceId, chatId)?.agentTurnMessageId ?? null,
      steps.length,
      finishedCommands,
    ].join('|'),
  }
}

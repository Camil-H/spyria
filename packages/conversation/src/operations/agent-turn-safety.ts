import type { MessageId, WorkspaceId } from '@hq/kernel'
import type { AgentChat } from '../contracts/agent.ts'
import type { ConversationTransactor } from '../contracts/transactor.ts'
import {
  agentNotices,
  reopenedTurnOutcomeOf,
  silentTurnMilliseconds,
  type TurnOutcome,
  turnEndNoticeOf,
} from '../domain/agent-events.ts'
import { type AgentDependencies, closeAgentTurn } from './agent-turn.ts'

const closeWithNotice = (transactor: ConversationTransactor, chat: AgentChat, promptId: MessageId, notice: string) =>
  transactor.run((unitOfWork) => closeAgentTurn(unitOfWork, chat.chatId, promptId, () => notice))

export const sweepAgentTurns = async (
  { transactor, runtimes, agentServer, eventSockets }: AgentDependencies,
  { workspaceId, now }: { workspaceId: WorkspaceId; now: number },
) => {
  for (const { chatId, promptId, lastEventAt } of await transactor.run(({ agentTurns }) => agentTurns.active())) {
    const chat = { workspaceId, chatId }
    const endpoint = await runtimes.endpointOf(chat)
    const isSilent = now - lastEventAt >= silentTurnMilliseconds
    const executionStatus =
      isSilent && endpoint?.conversationId
        ? await agentServer.statusOf({ ...endpoint, conversationId: endpoint.conversationId }).catch(() => undefined)
        : undefined
    if (executionStatus === 'running') await runtimes.touch(chat)
    else if (endpoint ? isSilent : isSilent || !(await runtimes.isWaitingOnHost(chat))) {
      eventSockets.stopStreaming(chat, promptId)
      await closeWithNotice(transactor, chat, promptId, endpoint ? agentNotices.noResponse : agentNotices.stoppedEarly)
    }
  }
  await transactor.run(({ agentJobs }) => agentJobs.sweepLater())
}

export const reopenAgentTurn = async ({ transactor, runtimes, agentServer }: AgentDependencies, chat: AgentChat) => {
  const promptId = await transactor.run(({ agentTurns }) => agentTurns.lock(chat.chatId))
  if (promptId === null) return undefined
  const endpoint = await runtimes.endpointOf(chat)
  if (!endpoint && (await runtimes.isWaitingOnHost(chat))) return undefined
  const conversation = endpoint?.conversationId ? { ...endpoint, conversationId: endpoint.conversationId } : undefined
  const executionStatus = conversation && (await agentServer.statusOf(conversation))
  if (conversation && executionStatus !== undefined)
    return { conversation, promptId, outcome: reopenedTurnOutcomeOf(executionStatus) }
  await closeWithNotice(transactor, chat, promptId, agentNotices.stoppedEarly)
  return undefined
}

export const closeReopenedTurn = (
  { transactor }: AgentDependencies,
  { chat, promptId, outcome }: { chat: AgentChat; promptId: MessageId; outcome: TurnOutcome },
) =>
  transactor.run((unitOfWork) =>
    closeAgentTurn(unitOfWork, chat.chatId, promptId, (hasReply) => turnEndNoticeOf(outcome, hasReply)),
  )

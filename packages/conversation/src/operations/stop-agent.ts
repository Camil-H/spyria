import { type ChatId, type MemberId, type MessageId, requireChatPermission, type WorkspaceId } from '@hq/kernel'
import type { ConversationTransactor } from '../contracts/transactor.ts'
import { stoppedByNoticeOf } from '../domain/agent-events.ts'
import { type AgentDependencies, closeAgentTurn } from './agent-turn.ts'
import { cancelToolApprovals } from './tool-approvals.ts'

type Input = { workspaceId: WorkspaceId; chatId: ChatId; promptId: MessageId; memberId: MemberId }

export const stopAgent = (
  { transactor }: { transactor: ConversationTransactor },
  { chatId, memberId }: { chatId: ChatId; memberId: MemberId },
) =>
  transactor.run(async ({ chats, agentTurns, agentJobs }) => {
    await requireChatPermission(chats, chatId, memberId, 'session.configure')
    const promptId = await agentTurns.lock(chatId)
    if (promptId !== null) await agentJobs.interrupt({ chatId, promptId, memberId })
  })

export const interruptAgent = async (
  { transactor, runtimes, agentClient, eventSockets }: AgentDependencies,
  { workspaceId, chatId, promptId, memberId }: Input,
) => {
  const chat = { workspaceId, chatId }
  if ((await transactor.run(({ agentTurns }) => agentTurns.lock(chatId))) !== promptId) return
  const subConversationIds = await transactor.run(({ delegations }) => delegations.stopRunning(chatId, promptId))
  const endpoint = await runtimes.endpointOf(chat)
  if (endpoint?.conversationId) await agentClient.interrupt({ ...endpoint, conversationId: endpoint.conversationId })
  for (const conversationId of subConversationIds)
    if (endpoint) await agentClient.interrupt({ ...endpoint, conversationId }).catch(() => undefined)
  cancelToolApprovals(chat)
  eventSockets.stopStreaming(chat, promptId)
  await transactor.run(async (unitOfWork) => {
    const notice = stoppedByNoticeOf(await unitOfWork.members.displayNameOf(memberId))
    await closeAgentTurn(unitOfWork, chatId, promptId, () => notice)
  })
}

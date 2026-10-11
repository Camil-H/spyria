import type { ChatId, MemberId, MessageId, WorkspaceId } from '@hq/kernel'
import type { ConversationTransactor } from '../contracts/transactor.ts'
import { agentNotices, stoppedByNoticeOf } from '../domain/agent-events.ts'
import { type AgentDependencies, appendNotice, closeAgentTurn } from './agent-turn.ts'

type Input = { workspaceId: WorkspaceId; chatId: ChatId; promptId: MessageId; memberId: MemberId }

export const stopAgent = (
  { transactor }: { transactor: ConversationTransactor },
  { chatId, memberId }: { chatId: ChatId; memberId: MemberId },
) =>
  transactor.run(async ({ agentTurns, agentJobs }) => {
    const promptId = await agentTurns.lock(chatId)
    if (promptId !== null) await agentJobs.interrupt({ chatId, promptId, memberId })
  })

export const interruptAgent = async (
  { transactor, runtimes, agentServer, eventSockets }: AgentDependencies,
  { workspaceId, chatId, promptId, memberId }: Input,
) => {
  const chat = { workspaceId, chatId }
  if ((await transactor.run(({ agentTurns }) => agentTurns.lock(chatId))) !== promptId) return
  const subConversationIds = await transactor.run(({ delegations }) => delegations.stopRunning(chatId, promptId))
  const endpoint = await runtimes.endpointOf(chat)
  if (endpoint?.conversationId) await agentServer.interrupt({ ...endpoint, conversationId: endpoint.conversationId })
  const isHarness = Boolean((await transactor.run(({ routing }) => routing.chatRouting(chatId))).harness)
  for (const conversationId of subConversationIds)
    if (endpoint) await agentServer.interrupt({ ...endpoint, conversationId }).catch(() => undefined)
  eventSockets.stopStreaming(chat, promptId)
  const isStoppedConversationKept =
    isHarness &&
    endpoint?.conversationId &&
    (await agentServer.deleteConversation({ ...endpoint, conversationId: endpoint.conversationId }).then(
      () => false,
      (error) => {
        console.error(`Deleting the agent conversation of chat ${chatId} failed: ${error}`)
        return true
      },
    ))
  if (isHarness) await runtimes.forgetConversation(chat)
  await transactor.run(async (unitOfWork) => {
    const notice = stoppedByNoticeOf(await unitOfWork.members.displayNameOf(memberId))
    await closeAgentTurn(unitOfWork, chatId, promptId, () => notice)
    if (isStoppedConversationKept)
      await appendNotice(unitOfWork, await unitOfWork.messages.get(promptId), agentNotices.newSession)
  })
}

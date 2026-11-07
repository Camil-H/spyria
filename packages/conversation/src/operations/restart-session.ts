import { type ChatId, type MemberId, requireChatPermission, type WorkspaceId } from '@spyria/kernel'
import type { ConversationTransactor } from '../contracts/transactor.ts'
import type { AgentDependencies } from './agent-turn.ts'
import { interruptAgent } from './stop-agent.ts'

type Input = { workspaceId: WorkspaceId; chatId: ChatId; memberId: MemberId }

export const restartSession = (
  { transactor }: { transactor: ConversationTransactor },
  { chatId, memberId }: { chatId: ChatId; memberId: MemberId },
) =>
  transactor.run(async ({ chats, agentJobs }) => {
    await requireChatPermission(chats, chatId, memberId, 'session.configure')
    await agentJobs.restartSession({ chatId, memberId })
  })

export const restartAgentSession = async (
  dependencies: AgentDependencies,
  { workspaceId, chatId, memberId }: Input,
) => {
  const { transactor, runtimes, agentClient, eventSockets } = dependencies
  const chat = { workspaceId, chatId }
  const promptId = await transactor.run(({ agentTurns }) => agentTurns.lock(chatId))
  if (promptId !== null) await interruptAgent(dependencies, { workspaceId, chatId, promptId, memberId })
  const endpoint = await runtimes.endpointOf(chat)
  if (!endpoint?.conversationId) return eventSockets.showSessionStartsOnNextMessage(chat)
  const conversation = { ...endpoint, conversationId: endpoint.conversationId }
  await eventSockets.ensureOpen(chat, conversation, null)
  if ((await agentClient.restartConversation(conversation).catch(() => 'error')) !== 'error') return
  await agentClient.deleteConversation(conversation).catch(() => undefined)
  await runtimes.forgetConversation(chat)
  eventSockets.showSessionStartsOnNextMessage(chat)
}

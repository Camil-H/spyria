import { type ChatId, type MemberId, type MessageId, requireChatPermission, type WorkspaceId } from '@spyria/kernel'
import type { AgentChat, AgentConversation } from '../contracts/agent.ts'
import type { ConversationTransactor } from '../contracts/transactor.ts'
import type { AgentDependencies } from './agent-turn.ts'
import { interruptAgent } from './stop-agent.ts'

type Input = { workspaceId: WorkspaceId; chatId: ChatId; memberId: MemberId; promptId: MessageId | null }

const laterTurnCheckMilliseconds = 1000

export const restartSession = (
  { transactor }: { transactor: ConversationTransactor },
  { chatId, memberId }: { chatId: ChatId; memberId: MemberId },
) =>
  transactor.run(async ({ chats, agentTurns, agentJobs }) => {
    await requireChatPermission(chats, chatId, memberId, 'session.configure')
    await agentJobs.restartSession({ chatId, memberId, promptId: await agentTurns.lock(chatId) })
  })

export const restartAgentSession = async (
  dependencies: AgentDependencies,
  { workspaceId, chatId, memberId, promptId }: Input,
): Promise<{ retryInMilliseconds: number } | undefined> => {
  const { transactor, runtimes, eventSockets } = dependencies
  const chat = { workspaceId, chatId }
  const runningPromptId = await transactor.run(({ agentTurns }) => agentTurns.lock(chatId))
  if (runningPromptId !== null && runningPromptId !== promptId)
    return { retryInMilliseconds: laterTurnCheckMilliseconds }
  if (promptId !== null) await interruptAgent(dependencies, { workspaceId, chatId, promptId, memberId })
  const endpoint = await runtimes.endpointOf(chat)
  if (endpoint?.conversationId)
    await restartConversation(dependencies, chat, { ...endpoint, conversationId: endpoint.conversationId })
  else eventSockets.showSessionStartsOnNextMessage(chat)
  return undefined
}

const restartConversation = async (
  { runtimes, agentClient, eventSockets }: AgentDependencies,
  chat: AgentChat,
  conversation: AgentConversation,
) => {
  await eventSockets.ensureOpen(chat, conversation, null)
  if ((await agentClient.restartConversation(conversation).catch(() => 'error')) !== 'error') return
  await agentClient.deleteConversation(conversation).catch(() => undefined)
  await runtimes.forgetConversation(chat)
  eventSockets.showSessionStartsOnNextMessage(chat)
}

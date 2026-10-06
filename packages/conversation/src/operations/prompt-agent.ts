import type { MessageId, WorkspaceId } from '@hq/kernel'
import type { AgentEventSockets, AgentRuntimes, AgentServer } from '../contracts/agent.ts'
import type { ConversationTransactor } from '../contracts/transactor.ts'
import { startFailureNoticeOf } from '../domain/agent-events.ts'
import { beginAgentTurn, noticePendingPrompts, releaseAgentTurn } from './agent-turn.ts'

type Dependencies = {
  transactor: ConversationTransactor
  runtimes: AgentRuntimes
  agentServer: AgentServer
  eventSockets: AgentEventSockets
}
type Input = { workspaceId: WorkspaceId; messageId: MessageId }

const runtimeStartPollMilliseconds = 500

export const promptAgent = async (
  { transactor, runtimes, agentServer, eventSockets }: Dependencies,
  { workspaceId, messageId }: Input,
) => {
  const { chatId, isRuntimeChat } = await transactor.run(async ({ messages, chats }) => {
    const message = await messages.get(messageId)
    return { chatId: message.chatId, isRuntimeChat: (await chats.get(message.chatId)).type === 'runtime' }
  })
  if (!isRuntimeChat) return undefined
  const chat = { workspaceId, chatId }
  const readiness = await runtimes.ensureRunning(chat)
  if (readiness.state === 'starting') return { retryInMilliseconds: runtimeStartPollMilliseconds }
  if (readiness.state === 'failed')
    return transactor.run((unitOfWork) =>
      noticePendingPrompts(unitOfWork, chatId, startFailureNoticeOf(readiness.failure)),
    )
  const { endpoint } = readiness
  const conversationId =
    endpoint.conversationId ??
    (await runtimes.rememberConversation(chat, await agentServer.createConversation(endpoint)))
  const conversation = { ...endpoint, conversationId }
  const prompt = await transactor.run((unitOfWork) => beginAgentTurn(unitOfWork, chatId))
  if (!prompt) return undefined
  try {
    await eventSockets.ensureOpen(chat, conversation, prompt.id)
    await agentServer.sendMessage(conversation, prompt.body)
  } catch (error) {
    await transactor.run((unitOfWork) => releaseAgentTurn(unitOfWork, chatId, prompt.id))
    throw error
  }
  await runtimes.touch(chat)
  return undefined
}

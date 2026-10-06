import type { MessageId, WorkspaceId } from '@hq/kernel'
import type { AgentChat, AgentEndpoint } from '../contracts/agent.ts'
import { agentNotices, startFailureNoticeOf } from '../domain/agent-events.ts'
import type { Message } from '../domain/message.ts'
import {
  type AgentDependencies,
  appendNotice,
  beginAgentTurn,
  noticeWaitingPrompts,
  releaseAgentTurn,
} from './agent-turn.ts'

type Input = { workspaceId: WorkspaceId; messageId: MessageId }

const runtimeStartPollMilliseconds = 500

const conversationFor = async (
  { transactor, runtimes, agentServer }: AgentDependencies,
  chat: AgentChat,
  endpoint: AgentEndpoint,
  prompt: Message,
) => {
  const storedId = endpoint.conversationId
  if (storedId !== null && (await agentServer.statusOf({ ...endpoint, conversationId: storedId })) !== undefined)
    return { ...endpoint, conversationId: storedId }
  if (storedId !== null) {
    await runtimes.forgetConversation(chat)
    await transactor.run((unitOfWork) => appendNotice(unitOfWork, prompt, agentNotices.newSession))
  }
  const conversationId = await runtimes.rememberConversation(chat, await agentServer.createConversation(endpoint))
  return { ...endpoint, conversationId }
}

export const promptAgent = async (dependencies: AgentDependencies, { workspaceId, messageId }: Input) => {
  const { transactor, runtimes, agentServer, eventSockets } = dependencies
  const { chatId, isRuntimeChat } = await transactor.run(async ({ messages, chats }) => {
    const message = await messages.get(messageId)
    return { chatId: message.chatId, isRuntimeChat: (await chats.get(message.chatId)).type === 'runtime' }
  })
  if (!isRuntimeChat) return undefined
  const chat = { workspaceId, chatId }
  const readiness = await runtimes.ensureRunning(chat)
  if (readiness.state === 'starting') return { retryInMilliseconds: runtimeStartPollMilliseconds }
  if (readiness.state !== 'ready') {
    const notice =
      readiness.state === 'host_offline' ? agentNotices.hostOffline : startFailureNoticeOf(readiness.failure)
    return transactor.run((unitOfWork) => noticeWaitingPrompts(unitOfWork, chatId, notice))
  }
  const prompt = await transactor.run((unitOfWork) => beginAgentTurn(unitOfWork, chatId))
  if (!prompt) return undefined
  try {
    const conversation = await conversationFor(dependencies, chat, readiness.endpoint, prompt)
    await eventSockets.ensureOpen(chat, conversation, prompt.id)
    await agentServer.sendMessage(conversation, prompt.body)
  } catch (error) {
    await transactor.run((unitOfWork) => releaseAgentTurn(unitOfWork, chatId, prompt.id))
    throw error
  }
  await runtimes.touch(chat)
  return undefined
}

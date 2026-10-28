import { type ChatId, ChatNotFound, type ChatPermission, type MemberId, requireChatPermission } from '@spyria/kernel'
import type { AgentChat, AgentConversation } from '../contracts/agent.ts'
import type { UnitOfWork } from '../contracts/transactor.ts'
import type { AgentDependencies } from './agent-turn.ts'

const forbiddenStatus = 403
const conflictStatus = 409

const mayPrompt = async ({ chats, members }: UnitOfWork, chatId: ChatId, memberId: MemberId) => {
  const chat = await chats.get(chatId)
  if (chat.type !== 'runtime' || chat.localSession === null) return false
  return chat.localSession ? chat.ownerId === memberId : members.hasLlmCredential(memberId)
}

export const forwardToAgent = async (
  { transactor, runtimes }: Pick<AgentDependencies, 'transactor' | 'runtimes'>,
  { chat, memberId, permission }: { chat: AgentChat; memberId: MemberId; permission: ChatPermission },
  forward: (conversation: AgentConversation) => Promise<number>,
) => {
  await transactor.run(({ chats }) => requireChatPermission(chats, chat.chatId, memberId, permission))
  const isAllowed = await transactor
    .run((unitOfWork) => mayPrompt(unitOfWork, chat.chatId, memberId))
    .catch((error) => (error instanceof ChatNotFound ? false : Promise.reject(error)))
  if (!isAllowed) return forbiddenStatus
  const endpoint = await runtimes.endpointOf(chat)
  if (!endpoint?.conversationId) return conflictStatus
  const status = await forward({ ...endpoint, conversationId: endpoint.conversationId })
  return status === 404 ? conflictStatus : status
}

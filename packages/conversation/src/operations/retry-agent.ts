import { type ChatId, type MemberId, requireChatPermission, type WorkspaceId } from '@hq/kernel'
import type { AgentHost, RuntimeRetrier } from '../contracts/agent.ts'
import type { ConversationTransactor } from '../contracts/transactor.ts'
import { type AgentDependencies, requestNextPrompt } from './agent-turn.ts'

export const retryAgent = async (
  { transactor, runtimeRetrier }: { transactor: ConversationTransactor; runtimeRetrier: RuntimeRetrier },
  { workspaceId, chatId, memberId }: { workspaceId: WorkspaceId; chatId: ChatId; memberId: MemberId },
) => {
  await transactor.run(({ chats }) => requireChatPermission(chats, chatId, memberId, 'chat.post'))
  await runtimeRetrier.retry({ workspaceId, chatId })
  await transactor.run((unitOfWork) => requestNextPrompt(unitOfWork, chatId))
}

export const promptWaitingChats = async ({ transactor, runtimes }: AgentDependencies, host: AgentHost) => {
  for (const chatId of await runtimes.chatsOnHost(host))
    await transactor.run((unitOfWork) => requestNextPrompt(unitOfWork, chatId))
}

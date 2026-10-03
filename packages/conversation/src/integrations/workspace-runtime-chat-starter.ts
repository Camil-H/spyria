import { type CreateChatFromChatDependencies, createChatFromChat } from '@hq/workspace/published'
import type { RuntimeChatStarter } from '../contracts/runtime-chat-starter.ts'

export const createWorkspaceRuntimeChatStarter = (
  workspaceDependencies: CreateChatFromChatDependencies,
): RuntimeChatStarter => ({
  start: async (input) => ({ chatId: await createChatFromChat(workspaceDependencies, input) }),
})

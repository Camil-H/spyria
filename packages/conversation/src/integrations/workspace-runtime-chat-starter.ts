import type { ZeroContext } from '@hq/db/zero-queries'
import type { ChatId } from '@hq/kernel'
import {
  type CreateChatFromChatDependencies,
  createChatFromChat,
  createZeroTransactor,
  runtimeChatDefaults,
} from '@hq/workspace/published'
import type { Transaction } from '@rocicorp/zero'
import type { RuntimeChatStarter } from '../contracts/runtime-chat-starter.ts'

export const createWorkspaceRuntimeChatStarter = (
  workspaceDependencies: CreateChatFromChatDependencies,
): RuntimeChatStarter => ({
  start: async (input) => ({ chatId: await createChatFromChat(workspaceDependencies, input) }),
})

export const createZeroRuntimeChatStarter = (tx: Transaction, context: ZeroContext, newChatId: ChatId) =>
  createWorkspaceRuntimeChatStarter({
    transactor: createZeroTransactor(tx, context),
    idGenerator: { next: () => newChatId },
    ...runtimeChatDefaults,
  })

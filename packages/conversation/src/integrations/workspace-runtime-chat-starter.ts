import type { ZeroContext } from '@hq/db/zero-queries'
import type { ChatId } from '@hq/kernel'
import { createChatFromChat, createZeroTransactor, runtimeChatDefaults } from '@hq/workspace/published'
import type { Transaction } from '@rocicorp/zero'
import type { RuntimeChatStarter } from '../contracts/runtime-chat-starter.ts'

export const createZeroRuntimeChatStarter = (
  tx: Transaction,
  context: ZeroContext,
  newChatId: ChatId,
): RuntimeChatStarter => ({
  start: async (input) => ({
    chatId: await createChatFromChat(
      { transactor: createZeroTransactor(tx, context), idGenerator: { next: () => newChatId }, ...runtimeChatDefaults },
      input,
    ),
  }),
})

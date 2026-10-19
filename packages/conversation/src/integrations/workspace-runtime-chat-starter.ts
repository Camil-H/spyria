import type { Transaction } from '@rocicorp/zero'
import type { ZeroContext } from '@spyria/db/zero-queries'
import { createChatFromChat, createZeroTransactor } from '@spyria/workspace/published'
import type { RuntimeChatStarter } from '../contracts/runtime-chat-starter.ts'

export const createZeroRuntimeChatStarter = (tx: Transaction, context: ZeroContext): RuntimeChatStarter => ({
  start: (input) => createChatFromChat({ transactor: createZeroTransactor(tx, context) }, input),
})

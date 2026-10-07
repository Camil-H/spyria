import type { ZeroContext } from '@hq/db/zero-queries'
import { createChatFromChat, createZeroTransactor } from '@hq/workspace/published'
import type { Transaction } from '@rocicorp/zero'
import type { RuntimeChatStarter } from '../contracts/runtime-chat-starter.ts'

export const createZeroRuntimeChatStarter = (tx: Transaction, context: ZeroContext): RuntimeChatStarter => ({
  start: (input) => createChatFromChat({ transactor: createZeroTransactor(tx, context) }, input),
})

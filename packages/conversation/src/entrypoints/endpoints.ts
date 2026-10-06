import { agentObservationOf } from '@hq/db/server-writes'
import type { ZeroContext } from '@hq/db/zero-queries'
import type { Transaction } from '@rocicorp/zero'
import { textOf } from '../domain/agent-steps.ts'

export const commandOutputPathOf = (chatId: string, stepId: string) => `/api/chats/${chatId}/steps/${stepId}/output`

export const readCommandOutput = async (tx: Transaction, context: ZeroContext, chatId: string, stepId: string) =>
  textOf((await agentObservationOf(tx, context.workspaceId, chatId, stepId))?.content)

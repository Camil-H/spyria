import { finishedToolCallEventOf } from '@hq/db/server-writes'
import type { ZeroContext } from '@hq/db/zero-queries'
import type { Transaction } from '@rocicorp/zero'
import { type AgentEvent, agentProjectionOf } from '../domain/agent-events.ts'
import { textOf } from '../domain/agent-steps.ts'

export const getCommandOutput = async (tx: Transaction, context: ZeroContext, chatId: string, stepId: string) => {
  const event = await finishedToolCallEventOf(tx, context.workspaceId, chatId, stepId)
  const projection = event && agentProjectionOf(event as AgentEvent)
  return projection?.type === 'observation' ? textOf(projection.observation?.content) : ''
}

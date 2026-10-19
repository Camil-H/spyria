import type { Transaction } from '@rocicorp/zero'
import { finishedToolCallEventOf } from '@spyria/db/server-writes'
import { chatPermissionsOf, type ZeroContext } from '@spyria/db/zero-queries'
import { requireChatPermission, chatId as toChatId } from '@spyria/kernel'
import { type AgentEvent, agentProjectionOf } from '../domain/agent-events.ts'
import { textOf } from '../domain/agent-steps.ts'

export const getCommandOutput = async (tx: Transaction, context: ZeroContext, chatId: string, stepId: string) => {
  await requireChatPermission(chatPermissionsOf(tx, context.workspaceId), toChatId(chatId), context.userId, 'chat.read')
  const event = await finishedToolCallEventOf(tx, context.workspaceId, chatId, stepId)
  const projection = event && agentProjectionOf(event as AgentEvent)
  return projection?.type === 'observation' ? textOf(projection.observation?.content) : ''
}

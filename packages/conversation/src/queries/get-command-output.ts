import { finishedToolCallEventOf } from '@hq/db/server-writes'
import { memberChatPermissions, type ZeroContext } from '@hq/db/zero-queries'
import { can, MissingChatPermission, chatId as toChatId } from '@hq/kernel'
import type { Transaction } from '@rocicorp/zero'
import { type AgentEvent, agentProjectionOf } from '../domain/agent-events.ts'
import { textOf } from '../domain/agent-steps.ts'

export const getCommandOutput = async (tx: Transaction, context: ZeroContext, chatId: string, stepId: string) => {
  if (!can(await memberChatPermissions(tx, context.workspaceId, toChatId(chatId), context.userId), 'chat.read'))
    throw new MissingChatPermission('chat.read')
  const event = await finishedToolCallEventOf(tx, context.workspaceId, chatId, stepId)
  const projection = event && agentProjectionOf(event as AgentEvent)
  return projection?.type === 'observation' ? textOf(projection.observation?.content) : ''
}

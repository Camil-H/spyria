import { agentObservationOf, chatModelCalls, gatewayKeyRefsOf } from '@hq/db/server-writes'
import type { ZeroContext } from '@hq/db/zero-queries'
import { providersOfGatewayRefs, reachableModelsOf } from '@hq/kernel'
import type { Transaction } from '@rocicorp/zero'
import { textOf } from '../domain/agent-steps.ts'

export const commandOutputPathOf = (chatId: string, stepId: string) => `/api/chats/${chatId}/steps/${stepId}/output`

export const readCommandOutput = async (tx: Transaction, context: ZeroContext, chatId: string, stepId: string) =>
  textOf((await agentObservationOf(tx, context.workspaceId, chatId, stepId))?.content)

export const chatRoutingPathOf = (chatId: string) => `/api/chats/${chatId}/routing`
export type ChatRoutingRead = {
  reachableModels: string[]
  contextTokens: number | null
  modelsUsed: { model: string; calls: number; tokens: number; costMicros: number }[]
}

export const readChatRouting = async (
  tx: Transaction,
  { workspaceId, userId }: ZeroContext,
  chatId: string,
): Promise<ChatRoutingRead> => {
  const calls = await chatModelCalls(tx, workspaceId, chatId)
  return {
    reachableModels: reachableModelsOf(providersOfGatewayRefs(await gatewayKeyRefsOf(tx, workspaceId, userId))).map(
      (model) => model.id,
    ),
    contextTokens: calls?.latest?.tokens ?? null,
    modelsUsed: calls?.models ?? [],
  }
}

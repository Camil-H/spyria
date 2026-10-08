import {
  agentObservationOf,
  chatModelCalls,
  listedModelsOf,
  memberKeyIdsOf,
  memberModelsOf,
} from '@hq/db/server-writes'
import type { ZeroContext } from '@hq/db/zero-queries'
import { chatModelsOf, type Model, routableModelNames, withPricesOf } from '@hq/kernel'
import type { Transaction } from '@rocicorp/zero'
import { textOf } from '../domain/agent-steps.ts'

export const commandOutputPathOf = (chatId: string, stepId: string) => `/api/chats/${chatId}/steps/${stepId}/output`

export const readCommandOutput = async (tx: Transaction, context: ZeroContext, chatId: string, stepId: string) =>
  textOf((await agentObservationOf(tx, context.workspaceId, chatId, stepId))?.content)

export const chatRoutingPathOf = (chatId: string) => `/api/chats/${chatId}/routing`
export type ChatRoutingRead = {
  reachableModels: Model[]
  modelNames: Record<string, string>
  contextTokens: number | null
  modelsUsed: { model: string; calls: number; tokens: number; costMicros: number }[]
}

export const readChatRouting = async (
  transact: <Result>(work: (tx: Transaction) => Promise<Result>) => Promise<Result>,
  { workspaceId, userId }: ZeroContext,
  chatId: string,
): Promise<ChatRoutingRead> => {
  const { calls, reachable, keyIds } = await transact(async (tx) => ({
    calls: await chatModelCalls(tx, workspaceId, chatId),
    reachable: chatModelsOf((await memberModelsOf(tx, workspaceId, userId)) ?? []),
    keyIds: await memberKeyIdsOf(tx, workspaceId, userId),
  }))
  return {
    reachableModels: withPricesOf(reachable, await listedModelsOf(keyIds)),
    modelNames: routableModelNames(),
    contextTokens: calls?.latest?.tokens ?? null,
    modelsUsed: calls?.models ?? [],
  }
}

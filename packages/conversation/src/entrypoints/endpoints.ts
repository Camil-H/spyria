import {
  agentObservationOf,
  chatContextTokens,
  isWorkspaceHostOnline,
  lastAdapterModelsOf,
  listedModelsOf,
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
  adapterModels: { currentModelId: string | null; available: { id: string; name: string }[] }
  hqRuntimeAvailable: boolean
}

export const readChatRouting = async (
  transact: <Result>(work: (tx: Transaction) => Promise<Result>) => Promise<Result>,
  { workspaceId, userId }: ZeroContext,
  chatId: string,
): Promise<ChatRoutingRead> => {
  const { contextTokens, reachable, adapterModels, hqRuntimeAvailable } = await transact(async (tx) => ({
    contextTokens: await chatContextTokens(tx, workspaceId, chatId),
    reachable: chatModelsOf((await memberModelsOf(tx, workspaceId, userId)) ?? []),
    adapterModels: await lastAdapterModelsOf(tx, workspaceId, chatId),
    hqRuntimeAvailable: await isWorkspaceHostOnline(tx, workspaceId),
  }))
  return {
    reachableModels: withPricesOf(reachable, listedModelsOf()),
    modelNames: routableModelNames(),
    contextTokens,
    adapterModels: {
      currentModelId: adapterModels?.isThisChat ? adapterModels.currentModelId : null,
      available: adapterModels?.availableModels.map(({ model_id, name }) => ({ id: model_id, name })) ?? [],
    },
    hqRuntimeAvailable,
  }
}

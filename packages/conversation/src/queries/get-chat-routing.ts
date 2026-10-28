import type { Transaction } from '@rocicorp/zero'
import { isWorkspaceHostOnline, lastAdapterModelsOf, listedModelsOf, memberModelsOf } from '@spyria/db/server-writes'
import { chatPermissionsOf, type ZeroContext } from '@spyria/db/zero-queries'
import {
  chatModelsOf,
  listedChatModelIdsOf,
  type Model,
  requireChatPermission,
  routableModelNames,
  chatId as toChatId,
  withPricesOf,
} from '@spyria/kernel'

export type ChatRoutingRead = {
  reachableModels: Model[]
  listedModelIds: string[]
  modelNames: Record<string, string>
  adapterModels: { currentModelId: string | null; available: { id: string; name: string }[] }
  adapterEfforts: { current: string | null; available: { id: string; name: string }[] }
  spyriaRuntimeAvailable: boolean
}

export const getChatRouting = async (
  transact: <Result>(work: (tx: Transaction) => Promise<Result>) => Promise<Result>,
  { workspaceId, userId }: ZeroContext,
  chatId: string,
): Promise<ChatRoutingRead> => {
  const { reachable, adapterModels, spyriaRuntimeAvailable } = await transact(async (tx) => {
    await requireChatPermission(chatPermissionsOf(tx, workspaceId), toChatId(chatId), userId, 'chat.read')
    return {
      reachable: chatModelsOf((await memberModelsOf(tx, workspaceId, userId)) ?? []),
      adapterModels: await lastAdapterModelsOf(tx, workspaceId, chatId),
      spyriaRuntimeAvailable: await isWorkspaceHostOnline(tx, workspaceId),
    }
  })
  return {
    reachableModels: withPricesOf(reachable, listedModelsOf()),
    listedModelIds: listedChatModelIdsOf(reachable, listedModelsOf()).filter(
      (id) => !reachable.some((model) => model.id === id),
    ),
    modelNames: routableModelNames(),
    adapterModels: {
      currentModelId: adapterModels?.isThisChat ? adapterModels.currentModelId : null,
      available: adapterModels?.availableModels.map(({ model_id, name }) => ({ id: model_id, name })) ?? [],
    },
    adapterEfforts: {
      current: adapterModels?.isThisChat ? adapterModels.currentEffort : null,
      available: adapterModels?.availableEfforts ?? [],
    },
    spyriaRuntimeAvailable,
  }
}

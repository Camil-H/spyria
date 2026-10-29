import type { Snapshot } from '@spyria/db'
import {
  type AiProviderAllowList,
  aiProviders,
  isAllowedProvider,
  reachableModelsOf,
  type WorkspaceId,
} from '@spyria/kernel'

export const getAiProviders = (workspaceId: WorkspaceId) => (snapshot: Snapshot) => {
  const allowList: AiProviderAllowList | null =
    snapshot.workspaces.find((workspace) => workspace.id === workspaceId)?.aiProviderAllowList ?? null
  return {
    allowList,
    providers: aiProviders.map(({ id, name }) => {
      const models = allowList === null ? 'all' : (allowList[id] ?? [])
      const catalog = reachableModelsOf([id]).map((model) => ({ id: model.id, name: model.name }))
      const others = models === 'all' ? [] : models.filter((model) => !catalog.some((known) => known.id === model))
      return {
        id,
        name,
        isAllowed: isAllowedProvider(allowList, id),
        models,
        choices: [...catalog, ...others.map((model) => ({ id: model, name: model }))],
      }
    }),
  }
}

import type { Snapshot } from '@spyria/db'
import { type AiProviderAllowList, aiProviders, isAllowedProvider, type WorkspaceId } from '@spyria/kernel'

export const getAiProviders = (workspaceId: WorkspaceId) => (snapshot: Snapshot) => {
  const allowList: AiProviderAllowList | null =
    snapshot.workspaces.find((workspace) => workspace.id === workspaceId)?.aiProviderAllowList ?? null
  return {
    allowList,
    providers: aiProviders.map(({ id, name, kind }) => ({
      id,
      name,
      kind,
      isAllowed: isAllowedProvider(allowList, id),
    })),
  }
}

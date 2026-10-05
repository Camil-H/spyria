import type { Snapshot } from '@hq/db'
import type { WorkspaceId } from '@hq/kernel'

export const listRuntimeHosts = (workspaceId: WorkspaceId) => (snapshot: Snapshot) =>
  snapshot.runtimeHosts.filter((host) => host.workspaceId === workspaceId)

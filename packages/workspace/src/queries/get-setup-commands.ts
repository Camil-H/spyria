import type { Snapshot } from '@spyria/db'
import type { WorkspaceId } from '@spyria/kernel'

export const setupCommandsOf = (workspaceId: WorkspaceId) => (snapshot: Snapshot) =>
  snapshot.workspaces.find((workspace) => workspace.id === workspaceId)?.setupCommands ?? []

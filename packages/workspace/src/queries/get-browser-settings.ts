import type { Snapshot } from '@spyria/db'
import { defaultBrowserSettings, type WorkspaceId } from '@spyria/kernel'

export const browserSettingsOf = (workspaceId: WorkspaceId) => (snapshot: Snapshot) =>
  snapshot.workspaces.find((workspace) => workspace.id === workspaceId)?.browser ?? defaultBrowserSettings

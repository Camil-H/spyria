import type { Snapshot } from '@hq/db'
import type { MemberId, WorkspaceId } from '@hq/kernel'

export const listRuntimeHosts = (workspaceId: WorkspaceId) => (snapshot: Snapshot) =>
  snapshot.runtimeHosts.filter((host) => host.workspaceId === workspaceId && host.ownerId === null)

export const localSessionsOf = (workspaceId: WorkspaceId) => (snapshot: Snapshot) =>
  snapshot.workspaces.find((workspace) => workspace.id === workspaceId)?.localSessions ?? true

export const getMachine = (workspaceId: WorkspaceId, memberId: MemberId) => (snapshot: Snapshot) =>
  snapshot.runtimeHosts.find((host) => host.workspaceId === workspaceId && host.ownerId === memberId)

import { type Snapshot, workspacePermissionsIn } from '@spyria/db'
import type { MemberId, WorkspaceId } from '@spyria/kernel'

export const getWorkspacePermissions = (workspaceId: WorkspaceId, memberId: MemberId) => (snapshot: Snapshot) =>
  workspacePermissionsIn(snapshot, workspaceId, memberId)

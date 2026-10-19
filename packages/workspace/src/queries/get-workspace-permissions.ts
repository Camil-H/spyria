import { type Snapshot, workspacePermissionsIn } from '@hq/db'
import type { MemberId, WorkspaceId } from '@hq/kernel'

export const getWorkspacePermissions = (workspaceId: WorkspaceId, memberId: MemberId) => (snapshot: Snapshot) =>
  workspacePermissionsIn(snapshot, workspaceId, memberId)

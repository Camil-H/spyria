import { useQuery } from '@hq/db/react'
import type { WorkspaceId } from '@hq/kernel'
import { useSession } from '@hq/session'
import { getWorkspacePermissions } from '../queries/get-workspace-permissions.ts'

export const useWorkspacePermissions = (workspaceId: WorkspaceId) =>
  useQuery(getWorkspacePermissions(workspaceId, useSession().memberId))

import { useQuery } from '@spyria/db/react'
import type { WorkspaceId } from '@spyria/kernel'
import { useSession } from '@spyria/session'
import { getWorkspacePermissions } from '../queries/get-workspace-permissions.ts'

export const useWorkspacePermissions = (workspaceId: WorkspaceId) =>
  useQuery(getWorkspacePermissions, workspaceId, useSession().memberId)

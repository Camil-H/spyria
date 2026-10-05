import { useQuery } from '@hq/db/react'
import type { WorkspaceId } from '@hq/kernel'
import { useSession } from '@hq/session'
import { isWorkspaceAdmin } from '../queries/is-workspace-admin.ts'

export const useIsWorkspaceAdmin = (workspaceId: WorkspaceId) =>
  useQuery(isWorkspaceAdmin(workspaceId, useSession().memberId))

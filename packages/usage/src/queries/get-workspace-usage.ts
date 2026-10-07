import type { Snapshot } from '@hq/db'
import type { WorkspaceId } from '@hq/kernel'
import type { UsageMonth, WorkspaceUsage } from '../domain/usage.ts'

export const getWorkspaceUsage =
  (_workspaceId: WorkspaceId, _month: UsageMonth) =>
  (_snapshot: Snapshot): WorkspaceUsage => ({
    months: [],
    total: { tokens: 0, costMicros: 0, calls: 0 },
    byMember: [],
    byProject: [],
  })

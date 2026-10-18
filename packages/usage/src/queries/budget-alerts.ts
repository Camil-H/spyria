import type { Snapshot } from '@hq/db'
import type { MemberId, WorkspaceId } from '@hq/kernel'

export const getOwnBudgetAlert =
  (workspaceId: WorkspaceId, memberId: MemberId, month: string) => (snapshot: Snapshot) =>
    Math.max(
      0,
      ...snapshot.budgetAlerts
        .filter((alert) => alert.workspaceId === workspaceId && alert.memberId === memberId && alert.month === month)
        .map((alert) => alert.threshold),
    )

export const countBudgetAlerts = (workspaceId: WorkspaceId, month: string) => (snapshot: Snapshot) =>
  new Set(
    snapshot.budgetAlerts
      .filter((alert) => alert.workspaceId === workspaceId && alert.month === month)
      .map((alert) => alert.memberId ?? ''),
  ).size

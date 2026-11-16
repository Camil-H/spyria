import type { Snapshot } from '@spyria/db'
import type { MemberId, WorkspaceId } from '@spyria/kernel'
import { type BudgetPeriod, budgetPeriods, isInCurrentPeriod } from '../domain/budgets.ts'

export type OwnBudgetAlert = { period: BudgetPeriod; threshold: number }

const currentAlertsOf = (snapshot: Snapshot, workspaceId: WorkspaceId, today: string) =>
  snapshot.budgetAlerts.filter(
    (alert) => alert.workspaceId === workspaceId && isInCurrentPeriod(alert, new Date(today)),
  )

const isMoreUrgent = (alert: OwnBudgetAlert, than: OwnBudgetAlert) =>
  alert.threshold > than.threshold ||
  (alert.threshold === than.threshold && budgetPeriods.indexOf(alert.period) > budgetPeriods.indexOf(than.period))

export const getOwnBudgetAlert =
  (workspaceId: WorkspaceId, memberId: MemberId, today: string) =>
  (snapshot: Snapshot): OwnBudgetAlert | null =>
    currentAlertsOf(snapshot, workspaceId, today)
      .filter((alert) => alert.memberId === memberId)
      .reduce<OwnBudgetAlert | null>(
        (urgent, { period, threshold }) =>
          urgent && !isMoreUrgent({ period, threshold }, urgent) ? urgent : { period, threshold },
        null,
      )

export const countBudgetAlerts = (workspaceId: WorkspaceId, today: string) => (snapshot: Snapshot) =>
  new Set(currentAlertsOf(snapshot, workspaceId, today).map((alert) => alert.memberId)).size

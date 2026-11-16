import { useQuery } from '@spyria/db/react'
import type { MemberId, WorkspaceId } from '@spyria/kernel'
import { formatCost } from '@spyria/ui'
import { type BudgetProgress, periodAdjectiveOf } from '../domain/budgets.ts'
import { getOwnBudgetAlert } from '../queries/budget-alerts.ts'

export const useOwnBudgetAlert = (workspaceId: WorkspaceId, memberId: MemberId) =>
  useQuery(getOwnBudgetAlert, workspaceId, memberId, new Date().toISOString().slice(0, 10))

export const BudgetNotice = ({ workspaceId, memberId }: { workspaceId: WorkspaceId; memberId: MemberId }) => {
  const alert = useOwnBudgetAlert(workspaceId, memberId)
  if (alert === null) return null
  const budgetName = `${periodAdjectiveOf(alert.period)} AI budget`
  return (
    <p
      role="status"
      aria-label="Budget alert"
      className={`rounded-md px-3 py-2 text-sm ${alert.threshold >= 100 ? 'bg-removed' : 'border border-line bg-raised'}`}
    >
      {alert.threshold >= 100
        ? `Your ${budgetName} is used up; a member with the Manage budgets permission can raise it in Workspace settings`
        : `You have used ${alert.threshold}% of your ${budgetName}`}
    </p>
  )
}

const barClassOf = (percent: number) => {
  if (percent >= 100) return 'bg-danger'
  return percent >= 80 ? 'bg-warning' : 'bg-accent'
}

export const BudgetBar = ({ label, progress }: { label: string; progress: BudgetProgress }) => {
  const percent = progress.percent ?? 0
  return (
    <div className="flex flex-col gap-1">
      <div
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.min(percent, 100)}
        className="h-2 overflow-hidden rounded-full bg-selected"
      >
        <div className={`h-full ${barClassOf(percent)}`} style={{ width: `${Math.min(percent, 100)}%` }} />
      </div>
      <p className="text-sm">
        {formatCost(progress.spentMicros)} of {formatCost(progress.limitMicros ?? 0)} ({percent}%)
      </p>
    </div>
  )
}

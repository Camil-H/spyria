import { useQuery } from '@spyria/db/react'
import type { MemberId, WorkspaceId } from '@spyria/kernel'
import { formatCost } from '@spyria/ui'
import { type BudgetProgress, monthOf } from '../domain/budgets.ts'
import { getOwnBudgetAlert } from '../queries/budget-alerts.ts'

export const useOwnBudgetAlert = (workspaceId: WorkspaceId, memberId: MemberId) =>
  useQuery(getOwnBudgetAlert(workspaceId, memberId, monthOf(new Date())))

export const BudgetNotice = ({ workspaceId, memberId }: { workspaceId: WorkspaceId; memberId: MemberId }) => {
  const threshold = useOwnBudgetAlert(workspaceId, memberId)
  if (threshold === 0) return null
  return (
    <p
      role="status"
      aria-label="Budget alert"
      className={`rounded-md px-3 py-2 text-sm ${threshold >= 100 ? 'bg-removed' : 'border border-line bg-raised'}`}
    >
      {threshold >= 100
        ? 'Your monthly AI budget is used up; an admin can raise it in Workspace settings'
        : `You have used ${threshold}% of your monthly AI budget`}
    </p>
  )
}

const barClassOf = (percent: number) => {
  if (percent >= 100) return 'bg-red-500'
  return percent >= 80 ? 'bg-yellow-500' : 'bg-accent'
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

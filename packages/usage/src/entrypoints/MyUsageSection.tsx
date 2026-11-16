import type { MemberId, WorkspaceId } from '@spyria/kernel'
import { ErrorMessage, failureMessageOf, formatCost, LabelledSection } from '@spyria/ui'
import { useEffect, useState } from 'react'
import { type PeriodBudget, periodTitleOf } from '../domain/budgets.ts'
import { BudgetBar, BudgetNotice, useOwnBudgetAlert } from './BudgetNotice.tsx'
import { useUsageCommands } from './providers.tsx'
import { SpendReportView } from './SpendReportView.tsx'

const OwnBudgetBars = ({ budgets }: { budgets: readonly PeriodBudget[] }) => {
  const limited = budgets.filter((budget) => budget.limitMicros !== null)
  const monthSpentMicros = budgets.find((budget) => budget.period === 'month')?.spentMicros ?? 0
  if (limited.length === 0)
    return <p className="text-sm text-muted">No AI budget · {formatCost(monthSpentMicros)} this month</p>
  return limited.map((budget) => {
    const budgetName = `${periodTitleOf(budget.period)} AI budget`
    return (
      <div key={budget.period} className="flex flex-col gap-1">
        <p className="text-xs text-muted">{budgetName}</p>
        <BudgetBar label={`${budgetName} used`} progress={budget} />
      </div>
    )
  })
}

const OwnBudget = ({ workspaceId, memberId }: { workspaceId: WorkspaceId; memberId: MemberId }) => {
  const commands = useUsageCommands()
  const alert = useOwnBudgetAlert(workspaceId, memberId)
  const [budgets, setBudgets] = useState<PeriodBudget[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const alertKey = alert && `${alert.period}/${alert.threshold}`
  useEffect(() => {
    if (alertKey !== undefined)
      commands
        .readOwnBudget({ workspaceId })
        .then(setBudgets, (error: unknown) => setLoadError(failureMessageOf(error)))
  }, [commands, workspaceId, alertKey])
  return (
    <LabelledSection title="AI budget" titleClass="text-sm font-medium">
      <BudgetNotice workspaceId={workspaceId} memberId={memberId} />
      {budgets === null ? (
        loadError ? (
          <ErrorMessage message={loadError} />
        ) : (
          <p className="text-sm text-muted">Loading…</p>
        )
      ) : (
        <OwnBudgetBars budgets={budgets} />
      )}
    </LabelledSection>
  )
}

export const MyUsageSection = ({ workspaceId, memberId }: { workspaceId: WorkspaceId; memberId: MemberId }) => {
  const commands = useUsageCommands()
  return (
    <SpendReportView
      label="My usage"
      workspaceId={workspaceId}
      readReport={commands.readOwnSpend}
      readTrend={commands.readOwnSpendTrend}
      chartDimensions={['model', 'chat']}
      tableDimensions={['chat', 'model']}
      isPersonal
    >
      <OwnBudget workspaceId={workspaceId} memberId={memberId} />
    </SpendReportView>
  )
}

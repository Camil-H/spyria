import { useQuery } from '@spyria/db/react'
import type { WorkspaceId, WorkspacePermission } from '@spyria/kernel'
import { calloutClass } from '@spyria/ui'
import { countBudgetAlerts } from '../queries/budget-alerts.ts'
import { BudgetsSection } from './BudgetsSection.tsx'
import { useUsageCommands } from './providers.tsx'
import { SpendReportView } from './SpendReportView.tsx'

const budgetsAnchor = 'budgets'

export const UsageSection = ({
  workspaceId,
  permissions,
}: {
  workspaceId: WorkspaceId
  permissions: readonly WorkspacePermission[]
}) => {
  const commands = useUsageCommands()
  const mayManageBudgets = permissions.includes('budgets.manage')
  const budgetAlertCount = useQuery(countBudgetAlerts, workspaceId, new Date().toISOString().slice(0, 7))
  return (
    <div className="flex flex-col gap-10">
      {mayManageBudgets && budgetAlertCount > 0 && (
        <p className={calloutClass}>
          {budgetAlertCount === 1 ? '1 budget is' : `${budgetAlertCount} budgets are`} over 80% this month.{' '}
          <a href={`#${budgetsAnchor}`} className="underline">
            See the budgets
          </a>
        </p>
      )}
      {permissions.includes('costs.view') && (
        <SpendReportView
          title="Usage"
          workspaceId={workspaceId}
          readReport={commands.readWorkspaceSpend}
          readTrend={commands.readWorkspaceSpendTrend}
          chartDimensions={['member', 'project', 'model']}
          tableDimensions={['member', 'project', 'chat', 'model']}
        />
      )}
      {mayManageBudgets && <BudgetsSection id={budgetsAnchor} workspaceId={workspaceId} />}
    </div>
  )
}

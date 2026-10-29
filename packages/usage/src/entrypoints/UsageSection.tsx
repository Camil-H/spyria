import type { WorkspaceId, WorkspacePermission } from '@spyria/kernel'
import { BudgetsSection } from './BudgetsSection.tsx'
import { useUsageCommands } from './providers.tsx'
import { SpendReportView } from './SpendReportView.tsx'

export const UsageSection = ({
  workspaceId,
  permissions,
}: {
  workspaceId: WorkspaceId
  permissions: readonly WorkspacePermission[]
}) => {
  const commands = useUsageCommands()
  return (
    <div className="flex flex-col gap-8">
      {permissions.includes('budgets.manage') && <BudgetsSection workspaceId={workspaceId} />}
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
    </div>
  )
}

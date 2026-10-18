import type { WorkspaceId } from '@hq/kernel'
import { BudgetsSection } from './BudgetsSection.tsx'
import { useUsageCommands } from './providers.tsx'
import { SpendReportView } from './SpendReportView.tsx'

export const UsageSection = ({ workspaceId }: { workspaceId: WorkspaceId }) => {
  const commands = useUsageCommands()
  return (
    <div className="flex flex-col gap-8">
      <BudgetsSection workspaceId={workspaceId} />
      <SpendReportView
        title="Usage"
        workspaceId={workspaceId}
        readReport={commands.readWorkspaceSpend}
        chartDimensions={['member', 'project', 'model']}
        tableDimensions={['member', 'project', 'chat', 'model']}
      />
    </div>
  )
}

import type { WorkspaceId } from '@hq/kernel'
import { useUsageCommands } from './providers.tsx'
import { SpendReportView } from './SpendReportView.tsx'

export const UsageSection = ({ workspaceId }: { workspaceId: WorkspaceId }) => {
  const commands = useUsageCommands()
  return (
    <SpendReportView
      title="Usage"
      workspaceId={workspaceId}
      readReport={commands.readWorkspaceSpend}
      chartDimensions={['member', 'project', 'model']}
      tableDimensions={['member', 'project', 'chat', 'model']}
    />
  )
}

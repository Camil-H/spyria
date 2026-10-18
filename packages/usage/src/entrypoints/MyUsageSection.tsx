import type { WorkspaceId } from '@hq/kernel'
import { useUsageCommands } from './providers.tsx'
import { SpendReportView } from './SpendReportView.tsx'

export const MyUsageSection = ({ workspaceId }: { workspaceId: WorkspaceId }) => {
  const commands = useUsageCommands()
  return (
    <SpendReportView
      title="My usage"
      workspaceId={workspaceId}
      readReport={commands.readOwnSpend}
      chartDimensions={['model', 'chat']}
      tableDimensions={['chat', 'model']}
    />
  )
}

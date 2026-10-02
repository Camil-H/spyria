import { useQuery } from '@hq/db'
import { getConnections } from '../queries/get-connections.ts'
import { LabelList } from './LabelList.tsx'
import type { TabProps } from './TabProps.ts'

export const ConnectionsTab = ({ workspaceId, chatId }: TabProps) => {
  const connections = useQuery(getConnections(workspaceId, chatId))
  if (!connections) return null
  return (
    <div className="flex flex-col gap-3">
      <h2 className="text-sm font-semibold">Connected tools</h2>
      <LabelList
        emptyMessage="No tools connected"
        rows={connections.map((connection) => ({
          key: connection.tool,
          label: connection.tool,
          value: connection.status,
        }))}
      />
    </div>
  )
}

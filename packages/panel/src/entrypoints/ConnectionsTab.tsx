import { useQuery } from '@hq/db/react'
import { LabelledSection } from '@hq/ui'
import { getConnections } from '../queries/get-connections.ts'
import { LabelList } from './LabelList.tsx'
import type { TabProps } from './TabProps.ts'

const ConnectionGroup = ({ title, ...list }: { title: string } & Parameters<typeof LabelList>[0]) => (
  <LabelledSection
    title={title}
    Heading="h3"
    className="flex flex-col gap-2"
    titleClass="text-xs font-semibold uppercase text-muted"
  >
    <LabelList {...list} />
  </LabelledSection>
)

export const ConnectionsTab = ({ workspaceId, chatId }: TabProps) => {
  const connections = useQuery(getConnections(workspaceId, chatId))
  if (!connections) return null
  return (
    <div className="flex flex-col gap-4">
      <h2 className="text-sm font-semibold">Connected tools</h2>
      <ConnectionGroup
        title="Workspace"
        emptyMessage="No workspace connections"
        rows={connections.workspace.map(({ tool, access }) => ({ key: tool, label: tool, value: access }))}
      />
      <ConnectionGroup
        title="Personal"
        emptyMessage="No personal connections"
        rows={connections.personal.map(({ tool, status }) => ({ key: tool, label: tool, value: status }))}
      />
    </div>
  )
}

import { useQuery } from '@hq/db'
import { useId } from 'react'
import { getConnections } from '../queries/get-connections.ts'
import { LabelList } from './LabelList.tsx'
import type { TabProps } from './TabProps.ts'

const ConnectionGroup = ({ title, ...list }: { title: string } & Parameters<typeof LabelList>[0]) => {
  const headingId = useId()
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-2">
      <h3 id={headingId} className="text-xs font-semibold uppercase text-muted">
        {title}
      </h3>
      <LabelList {...list} />
    </section>
  )
}

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

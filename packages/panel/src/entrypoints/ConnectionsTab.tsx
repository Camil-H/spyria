import { useQuery } from '@hq/db/react'
import { LabelledSection } from '@hq/ui'
import { getConnections } from '../queries/get-connections.ts'
import { LabelList } from './LabelList.tsx'
import type { TabProps } from './TabProps.ts'
import { emptyClass } from './ui.ts'

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

const ConnectionsTab = ({ workspaceId, chatId }: TabProps) => {
  const connections = useQuery(getConnections(workspaceId, chatId))
  if (!connections) return null
  return (
    <div className="flex flex-col gap-4">
      <ConnectionGroup
        title="Workspace"
        empty={<p className={emptyClass}>No workspace connections</p>}
        rows={connections.workspace.map(({ id, name, tools }) => ({
          key: id,
          label: name,
          value: tools.length > 0 ? tools.join(', ') : 'No tools',
        }))}
      />
      <ConnectionGroup
        title="Personal"
        empty={<p className={emptyClass}>No personal connections</p>}
        rows={connections.personal.map(({ tool, status }) => ({ key: tool, label: tool, value: status }))}
      />
    </div>
  )
}

export default ConnectionsTab

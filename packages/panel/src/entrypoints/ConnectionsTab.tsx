import { useQuery } from '@spyria/db/react'
import { getConnections } from '../queries/get-connections.ts'
import { LabelList } from './LabelList.tsx'
import type { TabProps } from './TabProps.ts'
import { emptyClass } from './ui.ts'

const ConnectionsTab = ({ workspaceId, chatId }: TabProps) => {
  const connections = useQuery(getConnections, workspaceId, chatId)
  if (!connections) return null
  return (
    <LabelList
      empty={<p className={emptyClass}>No tools for this chat</p>}
      rows={connections.map(({ id, name, signIn, tools, status }) => ({
        key: id,
        label: name,
        value: signIn === 'member' ? (status ?? 'Not connected') : tools.map((tool) => tool.name).join(', '),
      }))}
    />
  )
}

export default ConnectionsTab

import { useQuery } from '@spyria/db/react'
import { useSession } from '@spyria/session'
import { Switch } from '@spyria/ui'
import { getConnections } from '../queries/get-connections.ts'
import { LabelList } from './LabelList.tsx'
import { usePanelCommands } from './providers.tsx'
import type { TabProps } from './TabProps.ts'
import { emptyClass } from './ui.ts'

const ConnectionsTab = ({ workspaceId, chatId }: TabProps) => {
  const { memberId } = useSession()
  const commands = usePanelCommands()
  const usable = useQuery(getConnections, workspaceId, chatId, memberId)
  if (!usable) return null
  return (
    <LabelList
      empty={<p className={emptyClass}>None of your tools in this workspace</p>}
      rows={usable.connections.map(({ id, name, signIn, tools, status, isOn }) => ({
        key: id,
        label: usable.canSwitch ? (
          <Switch
            label={name}
            isOn={isOn}
            onToggle={() => commands.switchChatToolServer({ workspaceId, chatId, connectionId: id, isOn: !isOn })}
          />
        ) : (
          name
        ),
        value: !isOn
          ? 'Off in this chat'
          : signIn === 'member'
            ? (status ?? 'Not connected')
            : tools.map((tool) => tool.name).join(', '),
      }))}
    />
  )
}

export default ConnectionsTab

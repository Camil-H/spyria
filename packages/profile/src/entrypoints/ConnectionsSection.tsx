import { Content, List, Root, Trigger } from '@radix-ui/react-tabs'
import { useQuery } from '@spyria/db/react'
import type { MemberId, WorkspaceId } from '@spyria/kernel'
import { ErrorMessage, ghostButtonClass, LabelledSection, tabTriggerClass, useGuardedAction } from '@spyria/ui'
import { useEffect, useState } from 'react'
import { getPersonalConnections } from '../queries/get-personal-connections.ts'
import { getSharedConnections } from '../queries/get-shared-connections.ts'
import { GitHubConnectionRow } from './GitHubConnectionRow.tsx'
import { useProfileCommands } from './providers.tsx'

const rowClass = 'flex flex-wrap items-center gap-x-3 gap-y-1'
const tabClass = `${tabTriggerClass} px-3 text-sm`

export const ConnectionsSection = ({ workspaceId, memberId }: { workspaceId: WorkspaceId; memberId: MemberId }) => {
  const commands = useProfileCommands()
  const { errorMessage, run } = useGuardedAction()
  const shared = useQuery(getSharedConnections, workspaceId, memberId)
  const connected = useQuery(getPersonalConnections, workspaceId, memberId)
  const [servers, setServers] = useState<string[]>([])
  useEffect(() => {
    commands.availableTools({ workspaceId }).then(setServers, () => setServers([]))
  }, [commands, workspaceId])
  const available = servers.filter((server) => !connected.some(({ tool }) => tool === server))
  const act = (command: 'connectTool' | 'disconnectTool', tool: string) => () =>
    run(() => commands[command]({ workspaceId, tool }))
  return (
    <LabelledSection title="Connections">
      <Root defaultValue="shared" className="flex flex-col gap-3">
        <List aria-label="Connections" className="flex gap-1 border-b border-line">
          <Trigger value="shared" className={tabClass}>
            Shared with me
          </Trigger>
          <Trigger value="personal" className={tabClass}>
            My connections
          </Trigger>
        </List>
        <Content value="shared" className="flex flex-col gap-3">
          {shared.length === 0 ? (
            <p className="text-sm text-muted">No shared connections</p>
          ) : (
            <ul className="flex flex-col gap-2 text-sm">
              {shared.map(({ id, name, tools }) => (
                <li key={id} className={rowClass}>
                  <span className="font-medium">{name}</span>
                  <span className="text-muted">{tools.length > 0 ? tools.join(', ') : 'No tools'}</span>
                </li>
              ))}
            </ul>
          )}
        </Content>
        <Content value="personal" className="flex flex-col gap-3">
          <GitHubConnectionRow workspaceId={workspaceId} />
          {connected.length === 0 && <p className="text-sm text-muted">No personal connections</p>}
          <ul className="flex flex-col gap-2 text-sm">
            {connected.map(({ tool, status }) => (
              <li key={tool} className={rowClass}>
                <span className="font-medium">{tool}</span>
                <span className="text-muted">{status}</span>
                <span className="ml-auto flex gap-2">
                  {status === 'Needs reconnection' && (
                    <button type="button" className={ghostButtonClass} onClick={act('connectTool', tool)}>
                      Reconnect {tool}
                    </button>
                  )}
                  <button type="button" className={ghostButtonClass} onClick={act('disconnectTool', tool)}>
                    Disconnect {tool}
                  </button>
                </span>
              </li>
            ))}
          </ul>
          {available.map((tool) => (
            <fieldset key={tool} aria-label={tool} className={`${rowClass} text-sm`}>
              <span className="font-medium">{tool}</span>
              <span className="text-muted">Not connected</span>
              <button type="button" className={`${ghostButtonClass} ml-auto`} onClick={act('connectTool', tool)}>
                Connect {tool}
              </button>
            </fieldset>
          ))}
          <ErrorMessage message={errorMessage} />
        </Content>
      </Root>
    </LabelledSection>
  )
}

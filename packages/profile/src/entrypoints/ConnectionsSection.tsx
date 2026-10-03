import { useQuery } from '@hq/db/react'
import type { MemberId, WorkspaceId } from '@hq/kernel'
import { focusRing, ghostButtonClass } from '@hq/ui'
import { Content, List, Root, Trigger } from '@radix-ui/react-tabs'
import { connectTool } from '../operations/connect-tool.ts'
import { disconnectTool } from '../operations/disconnect-tool.ts'
import { getPersonalConnections } from '../queries/get-personal-connections.ts'
import { getSharedConnections } from '../queries/get-shared-connections.ts'
import { ErrorMessage } from './ErrorMessage.tsx'
import { useProfileDependencies } from './providers.tsx'
import { Section } from './Section.tsx'
import { useGuardedAction } from './useGuardedAction.ts'

const rowClass = 'flex flex-wrap items-center gap-x-3 gap-y-1'
const tabClass = `border-b-2 border-transparent px-3 py-2 text-sm text-muted hover:text-ink data-[state=active]:border-accent data-[state=active]:text-ink ${focusRing}`

export const ConnectionsSection = ({ workspaceId, memberId }: { workspaceId: WorkspaceId; memberId: MemberId }) => {
  const dependencies = useProfileDependencies()
  const { errorMessage, run } = useGuardedAction()
  const shared = useQuery(getSharedConnections(workspaceId, memberId))
  const { connected, available } = useQuery(getPersonalConnections(workspaceId, memberId))
  const act = (operation: typeof connectTool, tool: string) => () =>
    run(() => operation(dependencies, { workspaceId, memberId, tool }))
  return (
    <Section title="Connections">
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
              {shared.map(({ tool, access }) => (
                <li key={tool} className={rowClass}>
                  <span className="font-medium">{tool}</span>
                  <span className="text-muted">{access}</span>
                </li>
              ))}
            </ul>
          )}
        </Content>
        <Content value="personal" className="flex flex-col gap-3">
          {connected.length === 0 && <p className="text-sm text-muted">No personal connections</p>}
          <ul className="flex flex-col gap-2 text-sm">
            {connected.map(({ tool, status }) => (
              <li key={tool} className={rowClass}>
                <span className="font-medium">{tool}</span>
                <span className="text-muted">{status}</span>
                <span className="ml-auto flex gap-2">
                  {status === 'Needs reconnection' && (
                    <button type="button" className={ghostButtonClass} onClick={act(connectTool, tool)}>
                      Reconnect {tool}
                    </button>
                  )}
                  <button type="button" className={ghostButtonClass} onClick={act(disconnectTool, tool)}>
                    Disconnect {tool}
                  </button>
                </span>
              </li>
            ))}
          </ul>
          {available.length > 0 && (
            <div className="flex flex-wrap gap-2 text-sm">
              {available.map((tool) => (
                <button key={tool} type="button" className={ghostButtonClass} onClick={act(connectTool, tool)}>
                  Connect {tool}
                </button>
              ))}
            </div>
          )}
          <ErrorMessage message={errorMessage} />
        </Content>
      </Root>
    </Section>
  )
}

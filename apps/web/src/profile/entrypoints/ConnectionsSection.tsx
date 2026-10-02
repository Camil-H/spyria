import { useQuery } from '@hq/db'
import type { MemberId, WorkspaceId } from '@hq/kernel'
import { ghostButtonClass } from '@hq/ui'
import { connectTool } from '../operations/connect-tool.ts'
import { disconnectTool } from '../operations/disconnect-tool.ts'
import { getPersonalConnections } from '../queries/get-personal-connections.ts'
import { getSharedConnections } from '../queries/get-shared-connections.ts'
import { ErrorMessage } from './ErrorMessage.tsx'
import { useProfileDependencies } from './providers.tsx'
import { Section } from './Section.tsx'
import { useGuardedAction } from './useGuardedAction.ts'

const rowClass = 'flex flex-wrap items-center gap-x-3 gap-y-1'

export const ConnectionsSection = ({ workspaceId, memberId }: { workspaceId: WorkspaceId; memberId: MemberId }) => {
  const dependencies = useProfileDependencies()
  const { errorMessage, run } = useGuardedAction()
  const shared = useQuery(getSharedConnections(workspaceId, memberId))
  const { connected, available } = useQuery(getPersonalConnections(workspaceId, memberId))
  const act = (operation: typeof connectTool, tool: string) => () =>
    run(() => operation(dependencies, { workspaceId, memberId, tool }))
  return (
    <Section title="Connections">
      <Section title="Shared with me" level={3}>
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
      </Section>
      <Section title="My personal connections" level={3}>
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
      </Section>
    </Section>
  )
}

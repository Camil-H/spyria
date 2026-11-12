import { useQuery } from '@spyria/db/react'
import type { MemberId, WorkspaceId } from '@spyria/kernel'
import { ErrorMessage, ghostButtonClass, LabelledSection, useGuardedAction } from '@spyria/ui'
import { useEffect, useState } from 'react'
import { connectionStatuses, notConnectedStatus } from '../domain/tool-connection.ts'
import { connectionSignIns } from '../domain/workspace-connection.ts'
import { getGitHubApprovals, getToolConnections } from '../queries/get-tool-connections.ts'
import { GitHubConnectionRow } from './GitHubConnectionRow.tsx'
import { useProfileCommands } from './providers.tsx'
import { ToolApprovals } from './ToolApprovals.tsx'
import { toolCountsOf } from './ToolList.tsx'

export const ConnectionsSection = ({ workspaceId, memberId }: { workspaceId: WorkspaceId; memberId: MemberId }) => {
  const commands = useProfileCommands()
  const { errorMessage, run } = useGuardedAction()
  const connections = useQuery(getToolConnections, workspaceId, memberId)
  const github = useQuery(getGitHubApprovals, workspaceId, memberId)
  const [disconnectedTool, setDisconnectedTool] = useState<string>()
  const [approvalsShown, setApprovalsShown] = useState<string>()
  useEffect(() => {
    commands.checkTools({ workspaceId }).catch(() => undefined)
  }, [commands, workspaceId])
  const connect = (tool: string) => () => {
    setDisconnectedTool(undefined)
    return run(() => commands.connectTool({ workspaceId, tool }))
  }
  const disconnect = (tool: string) => async () => {
    if (await run(() => commands.disconnectTool({ workspaceId, tool }))) setDisconnectedTool(tool)
  }
  return (
    <LabelledSection id="connections" title="Tool connections">
      <GitHubConnectionRow workspaceId={workspaceId} />
      {github && github.tools.length > 0 && (
        <div className="flex flex-col gap-1 text-sm">
          <button
            type="button"
            className={`${ghostButtonClass} w-fit`}
            onClick={() => setApprovalsShown(approvalsShown === github.id ? undefined : github.id)}
          >
            Approvals for {github.name}
          </button>
          {approvalsShown === github.id && <ToolApprovals workspaceId={workspaceId} server={github} />}
        </div>
      )}
      {connections.length === 0 ? (
        <p className="text-sm text-muted">No tools available to you in this workspace yet</p>
      ) : (
        <ul aria-label="Tools" className="flex flex-col gap-2 text-sm">
          {connections.map((connection) => {
            const { id, name, signIn, tools, status } = connection
            return (
              <li key={id} aria-label={name} className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className="font-medium">{name}</span>
                {signIn === connectionSignIns.member ? (
                  <>
                    <span className="text-muted">{status ?? notConnectedStatus}</span>
                    <span className="ml-auto flex gap-2">
                      {status !== connectionStatuses.connected && (
                        <button type="button" className={ghostButtonClass} onClick={connect(name)}>
                          {status ? 'Reconnect' : 'Connect'} {name}
                        </button>
                      )}
                      {status && (
                        <button type="button" className={ghostButtonClass} onClick={disconnect(name)}>
                          Disconnect {name}
                        </button>
                      )}
                    </span>
                  </>
                ) : (
                  <span className="text-muted">Shared login: {toolCountsOf(tools)}</span>
                )}
                <button
                  type="button"
                  className={ghostButtonClass}
                  onClick={() => setApprovalsShown(approvalsShown === id ? undefined : id)}
                >
                  Approvals for {name}
                </button>
                {approvalsShown === id && (
                  <div className="basis-full">
                    <ToolApprovals workspaceId={workspaceId} server={connection} />
                  </div>
                )}
              </li>
            )
          })}
        </ul>
      )}
      {disconnectedTool && (
        <p role="status" className="text-sm text-muted">
          Spyria no longer uses your {disconnectedTool} account. {disconnectedTool} still lists the access you granted:
          remove it in your {disconnectedTool} settings to revoke it there too.
        </p>
      )}
      <ErrorMessage message={errorMessage} />
    </LabelledSection>
  )
}

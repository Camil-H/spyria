import { useQuery } from '@spyria/db/react'
import type { MemberId, WorkspaceId } from '@spyria/kernel'
import { ErrorMessage, rowListClass, StatusBadge, smallButtonClass, useGuardedAction } from '@spyria/ui'
import { useEffect, useState } from 'react'
import { connectionStatuses, notConnectedStatus } from '../domain/tool-connection.ts'
import { connectionSignIns } from '../domain/workspace-connection.ts'
import { getGitHubApprovals, getToolConnections } from '../queries/get-tool-connections.ts'
import { ConnectionRow } from './ConnectionRow.tsx'
import { GitHubConnectionRow } from './GitHubConnectionRow.tsx'
import { useProfileCommands } from './providers.tsx'
import { ToolApprovals } from './ToolApprovals.tsx'
import { toolCountsOf } from './ToolList.tsx'

const toneOf = (status: string | undefined) =>
  status === connectionStatuses.connected ? 'ok' : status ? 'attention' : 'off'

export const ConnectionsSection = ({ workspaceId, memberId }: { workspaceId: WorkspaceId; memberId: MemberId }) => {
  const commands = useProfileCommands()
  const { errorMessage, run } = useGuardedAction()
  const connections = useQuery(getToolConnections, workspaceId, memberId)
  const github = useQuery(getGitHubApprovals, workspaceId, memberId)
  const [disconnectedTool, setDisconnectedTool] = useState<string>()
  const [approvalsServerId, setApprovalsServerId] = useState<string>()
  const approvalsServer = [...(github ? [github] : []), ...connections].find(({ id }) => id === approvalsServerId)
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
    <section aria-label="Connections" className="flex flex-col gap-3">
      <p className="text-sm text-muted">
        The accounts agents use as you, and which of their calls wait for your approval.
      </p>
      <ul aria-label="Your accounts and tools" className={rowListClass}>
        <GitHubConnectionRow
          workspaceId={workspaceId}
          onApprovals={github && github.tools.length > 0 ? () => setApprovalsServerId(github.id) : undefined}
        />
        {connections.map(({ id, name, signIn, tools, status }) => {
          const signsInAsMember = signIn === connectionSignIns.member
          const connectVerb = status ? 'Reconnect' : 'Connect'
          return (
            <ConnectionRow
              key={id}
              label={name}
              name={name}
              status={
                signsInAsMember ? (
                  <StatusBadge tone={toneOf(status)}>{status ?? notConnectedStatus}</StatusBadge>
                ) : (
                  <span className="text-muted">Shared login · {toolCountsOf(tools)}</span>
                )
              }
              action={
                signsInAsMember &&
                status !== connectionStatuses.connected && (
                  <button
                    type="button"
                    aria-label={`${connectVerb} ${name}`}
                    className={smallButtonClass}
                    onClick={connect(name)}
                  >
                    {connectVerb}
                  </button>
                )
              }
              menuItems={[
                { label: 'Approvals', onSelect: () => setApprovalsServerId(id) },
                ...(signsInAsMember && status ? [{ label: 'Disconnect', onSelect: disconnect(name) }] : []),
              ]}
            />
          )
        })}
      </ul>
      {connections.length === 0 && (
        <p className="text-sm text-muted">No other tools are available to you in this workspace yet</p>
      )}
      {disconnectedTool && (
        <p role="status" className="text-sm text-muted">
          Spyria no longer uses your {disconnectedTool} account. {disconnectedTool} still lists the access you granted:
          remove it in your {disconnectedTool} settings to revoke it there too.
        </p>
      )}
      <ErrorMessage message={errorMessage} />
      {approvalsServer && (
        <ToolApprovals
          workspaceId={workspaceId}
          server={approvalsServer}
          onClose={() => setApprovalsServerId(undefined)}
        />
      )}
    </section>
  )
}

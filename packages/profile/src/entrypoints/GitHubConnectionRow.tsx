import type { WorkspaceId } from '@spyria/kernel'
import { ErrorMessage, StatusBadge, smallButtonClass, useGuardedAction } from '@spyria/ui'
import { useEffect, useState } from 'react'
import { type GitHubConnection, githubConnectionStatusOf } from '../domain/github-connection.ts'
import { ConnectionRow } from './ConnectionRow.tsx'
import { useProfileCommands } from './providers.tsx'

export const GitHubConnectionRow = ({
  workspaceId,
  onApprovals,
}: {
  workspaceId: WorkspaceId
  onApprovals?: () => void
}) => {
  const commands = useProfileCommands()
  const { errorMessage, run } = useGuardedAction()
  const [connection, setConnection] = useState<GitHubConnection>(null)
  useEffect(() => {
    commands.readGitHubConnection({ workspaceId }).then(setConnection, () => setConnection(null))
  }, [commands, workspaceId])
  const connect = () => run(async () => setConnection(await commands.connectGitHub({ workspaceId })))
  const disconnect = () =>
    run(async () => {
      await commands.disconnectGitHub({ workspaceId })
      setConnection(null)
    })
  const connectVerb = connection ? 'Reconnect' : 'Connect'
  return (
    <ConnectionRow
      label="GitHub account"
      name="GitHub"
      status={
        <StatusBadge tone={!connection ? 'off' : connection.state === 'connected' ? 'ok' : 'attention'}>
          {githubConnectionStatusOf(connection)}
        </StatusBadge>
      }
      action={
        connection?.state !== 'connected' && (
          <button
            type="button"
            aria-label={`${connectVerb} GitHub account`}
            className={smallButtonClass}
            onClick={connect}
          >
            {connectVerb}
          </button>
        )
      }
      menuItems={[
        ...(onApprovals ? [{ label: 'Approvals', onSelect: onApprovals }] : []),
        ...(connection ? [{ label: 'Disconnect', onSelect: disconnect }] : []),
      ]}
    >
      {errorMessage && (
        <div className="basis-full">
          <ErrorMessage message={errorMessage} />
        </div>
      )}
    </ConnectionRow>
  )
}

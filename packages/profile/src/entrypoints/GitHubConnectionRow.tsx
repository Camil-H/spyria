import type { WorkspaceId } from '@hq/kernel'
import { ErrorMessage, ghostButtonClass, useGuardedAction } from '@hq/ui'
import { useEffect, useState } from 'react'
import { type GitHubConnection, githubConnectionStatusOf } from '../domain/github-connection.ts'
import { useProfileCommands } from './providers.tsx'

export const GitHubConnectionRow = ({ workspaceId }: { workspaceId: WorkspaceId }) => {
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
  return (
    <fieldset aria-label="GitHub account" className="flex flex-col gap-1 text-sm">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="font-medium">GitHub account</span>
        <span className="text-muted">{githubConnectionStatusOf(connection)}</span>
        <span className="ml-auto flex gap-2">
          {connection?.state !== 'connected' && (
            <button type="button" className={ghostButtonClass} onClick={connect}>
              {connection ? 'Reconnect GitHub account' : 'Connect GitHub account'}
            </button>
          )}
          {connection && (
            <button type="button" className={ghostButtonClass} onClick={disconnect}>
              Disconnect GitHub account
            </button>
          )}
        </span>
      </div>
      <ErrorMessage message={errorMessage} />
    </fieldset>
  )
}

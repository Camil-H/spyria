import { connectionStatuses, notConnectedStatus } from './personal-connection.ts'

export type GitHubConnection = { login: string; state: 'connected' | 'needs_reconnection' } | null

export const githubConnectionStatusOf = (connection: GitHubConnection) =>
  !connection
    ? notConnectedStatus
    : connection.state === 'connected'
      ? `${connectionStatuses.connected} (${connection.login})`
      : connectionStatuses.needsReconnection

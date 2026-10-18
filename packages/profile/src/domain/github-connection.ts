export type GitHubConnection = { login: string; state: 'connected' | 'needs_reconnection' } | null

export const githubConnectionStatusOf = (connection: GitHubConnection) =>
  !connection
    ? 'Not connected'
    : connection.state === 'connected'
      ? `Connected (${connection.login})`
      : 'Needs reconnection'

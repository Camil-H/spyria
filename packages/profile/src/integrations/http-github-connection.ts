import type { WorkspaceId } from '@spyria/kernel'
import type { GitHubConnection } from '../domain/github-connection.ts'
import { throwOnRefusal } from './http-refusal.ts'
import { signInThroughWindow } from './sign-in-window.ts'

export const githubConnectionPath = '/api/github/connection'
export const githubConnectionChannel = 'spyria-github-connection'

type RequestAsMember = (workspaceId: WorkspaceId, path: string, method: string) => Promise<Response>
type Input = { workspaceId: WorkspaceId }

export const createHttpGitHubConnection = (requestAsMember: RequestAsMember) => {
  const call = async (workspaceId: WorkspaceId, path: string, method = 'POST') => {
    const response = await requestAsMember(workspaceId, `${githubConnectionPath}${path}`, method)
    await throwOnRefusal(response, 'The GitHub connection request')
    const body = await response.text()
    return (body ? JSON.parse(body) : {}) as Record<string, unknown>
  }
  const readGitHubConnection = async ({ workspaceId }: Input) =>
    (await call(workspaceId, '', 'GET')).connection as GitHubConnection
  return {
    readGitHubConnection,
    connectGitHub: async ({ workspaceId }: Input) => {
      await signInThroughWindow(
        githubConnectionChannel,
        async () => (await call(workspaceId, '/connect')) as { authorizeUrl: string },
      )
      return readGitHubConnection({ workspaceId })
    },
    disconnectGitHub: async ({ workspaceId }: Input) => {
      await call(workspaceId, '/disconnect')
    },
  }
}

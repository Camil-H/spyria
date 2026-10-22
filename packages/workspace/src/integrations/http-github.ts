import { type ChatId, chatId, DomainError, type ProjectId, type WorkspaceId } from '@spyria/kernel'
import type { GitHubRepository, GitHubSettingsInput, GitHubSettingsView } from '../domain/github.ts'

export const githubSettingsPath = '/api/github-settings'
export const githubAppManifestPath = '/api/github-settings/manifest'
export const githubRepositoriesPath = '/api/github/repositories'
export const githubBranchesPath = '/api/github/branches'
export const devChatsPath = '/api/dev-chats'

type PostAsMember = (workspaceId: WorkspaceId, path: string, body?: string) => Promise<Response>
type GetAsMember = (workspaceId: WorkspaceId, path: string) => Promise<Response>

const bodyOf = async <Body>(response: Response) => {
  const body = (await response.json().catch(() => ({}))) as Body & { error?: string; message?: string }
  if (!response.ok)
    throw new DomainError(body.error ?? 'internal', body.message ?? `The request was refused with ${response.status}`)
  return body
}

export const createHttpGitHubCommands = (postAsMember: PostAsMember, getAsMember: GetAsMember) => ({
  readGitHubSettings: async ({ workspaceId }: { workspaceId: WorkspaceId }) =>
    (await bodyOf<{ settings: GitHubSettingsView | null }>(await getAsMember(workspaceId, githubSettingsPath)))
      .settings,
  saveGitHubSettings: async ({ workspaceId, ...input }: GitHubSettingsInput & { workspaceId: WorkspaceId }) =>
    (
      await bodyOf<{ settings: GitHubSettingsView | null }>(
        await postAsMember(workspaceId, githubSettingsPath, JSON.stringify(input)),
      )
    ).settings,
  startGitHubAppCreation: async ({ workspaceId, organization }: { workspaceId: WorkspaceId; organization: string }) =>
    bodyOf<{ formAction: string; manifest: string }>(
      await postAsMember(workspaceId, githubAppManifestPath, JSON.stringify({ organization })),
    ),
  listRepositories: async ({ workspaceId }: { workspaceId: WorkspaceId }) =>
    (await bodyOf<{ repositories: GitHubRepository[] }>(await getAsMember(workspaceId, githubRepositoriesPath)))
      .repositories,
  listBranches: async ({ workspaceId, repository }: { workspaceId: WorkspaceId; repository: string }) =>
    (
      await bodyOf<{ branches: string[] }>(
        await getAsMember(workspaceId, `${githubBranchesPath}?${new URLSearchParams({ repository })}`),
      )
    ).branches,
  createDevChat: async ({
    workspaceId,
    ...input
  }: {
    workspaceId: WorkspaceId
    name: string
    projectId: ProjectId | null
    repository: string
    baseBranch: string
  }): Promise<ChatId> =>
    chatId(
      (await bodyOf<{ chatId: string }>(await postAsMember(workspaceId, devChatsPath, JSON.stringify(input)))).chatId,
    ),
})

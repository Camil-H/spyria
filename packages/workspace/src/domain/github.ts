import { BranchNotFound, InvalidGitHubSettings, RepositoryNotGranted } from './errors.ts'

export type GitHubSettingsInput = {
  appId: string
  clientId: string
  clientSecret?: string
  privateKey?: string
  webhookSecret?: string
}
export type GitHubSettings = { appId: string; clientId: string }
export type GitHubSecrets = Required<Pick<GitHubSettingsInput, 'clientSecret' | 'privateKey' | 'webhookSecret'>>
export type GitHubRepository = { fullName: string; defaultBranch: string }
export type GitHubSettingsView = GitHubSettings & { repositories: GitHubRepository[]; listingFailure: string | null }
export type DevChatInput = { name: string; projectId: string | null; repository: string; baseBranch: string }

export const githubSecretNames = ['clientSecret', 'privateKey', 'webhookSecret'] as const
export const githubCallbackPath = '/auth/github/callback'
export const githubWebhooksPath = '/api/github/webhooks'
const appIdPattern = /^\d+$/
const repositoryNamePattern = /^[\w-]+\/(?!\.\.?$)[\w.-]+$/
const workingBranchSlugLength = 40

const trimmed = (value: unknown) => (typeof value === 'string' ? value.trim() : '')

export const githubSettingsFrom = (input: GitHubSettingsInput): GitHubSettings => {
  const appId = trimmed(input.appId)
  const clientId = trimmed(input.clientId)
  if (!appIdPattern.test(appId)) throw new InvalidGitHubSettings('The App id is a number')
  if (clientId === '') throw new InvalidGitHubSettings('A client id is required')
  return { appId, clientId }
}

export const enteredSecretsOf = (input: GitHubSettingsInput) =>
  Object.fromEntries(
    githubSecretNames.flatMap((name) => (trimmed(input[name]) ? [[name, trimmed(input[name])]] : [])),
  ) as Partial<GitHubSecrets>

export const repositoryNameOf = (repository: string) => {
  if (!repositoryNamePattern.test(trimmed(repository)))
    throw new RepositoryNotGranted(trimmed(repository) || 'The repository')
  return trimmed(repository)
}

export const existingBranchOf = (repository: string, branches: readonly string[], branch: string) => {
  if (!branches.includes(trimmed(branch))) throw new BranchNotFound(repository, trimmed(branch))
  return trimmed(branch)
}

export const workingBranchOf = (chatName: string, chatId: string) => {
  const slug = chatName
    .toLowerCase()
    .normalize('NFKD')
    .replace(/\p{Mark}/gu, '')
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, workingBranchSlugLength)
    .replace(/^-+|-+$/g, '')
  return `spyria/${slug || 'chat'}-${chatId.replace(/-/g, '').slice(0, 6)}`
}

import type { ChatVisibility } from '@spyria/kernel'
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
export type DevChatInput = {
  name: string
  projectId: string | null
  repository: string
  baseBranch: string
  visibility?: ChatVisibility
}

export const githubSecretNames = ['clientSecret', 'privateKey', 'webhookSecret'] as const
export const githubCallbackPath = '/auth/github/callback'
export const githubWebhooksPath = '/api/github/webhooks'
export const githubAppCreatedPath = '/auth/github/app-created'
export const githubAppPermissions = {
  contents: 'write',
  pull_requests: 'write',
  issues: 'read',
  checks: 'read',
  actions: 'read',
  metadata: 'read',
  workflows: 'write',
} as const
export const githubAppEvents = [
  'pull_request',
  'pull_request_review',
  'pull_request_review_comment',
  'pull_request_review_thread',
  'check_suite',
  'check_run',
]
const appNameLength = 34
const organizationLoginPattern = /^[a-z\d](?:[a-z\d-]{0,38})$/i
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

export const githubLabelOf = (key: string) => `${key.charAt(0).toUpperCase()}${key.slice(1).replaceAll('_', ' ')}`

export const organizationLoginOf = (organization: unknown) => {
  const login = trimmed(organization)
  if (login !== '' && !organizationLoginPattern.test(login))
    throw new InvalidGitHubSettings('Enter the organization login as it appears in its GitHub URL')
  return login || undefined
}

export const githubAppManifestOf = ({
  appOrigin,
  workspaceId,
  workspaceName,
  nameSuffix,
}: {
  appOrigin: string
  workspaceId: string
  workspaceName: string
  nameSuffix: string
}) => ({
  name: `${`Spyria ${workspaceName}`.slice(0, appNameLength - nameSuffix.length - 1).trim()} ${nameSuffix}`,
  url: appOrigin,
  hook_attributes: { url: `${appOrigin}${githubWebhooksPath}`, active: true },
  redirect_url: `${appOrigin}${githubAppCreatedPath}`,
  callback_urls: [`${appOrigin}${githubCallbackPath}`],
  setup_url: `${appOrigin}/w/${workspaceId}/settings/github`,
  setup_on_update: true,
  request_oauth_on_install: false,
  public: false,
  default_permissions: githubAppPermissions,
  default_events: githubAppEvents,
})

export type RepositoryListing =
  | { state: 'loading' }
  | { state: 'failed' }
  | { state: 'listed'; repositories: GitHubRepository[] }

export const listedRepositoriesOf = (listing: RepositoryListing) =>
  listing.state === 'listed' ? listing.repositories : []

export const repositoryPromptOf = (listing: RepositoryListing, withoutOwn: number, own: string) =>
  listing.state === 'loading'
    ? 'Listing repositories…'
    : listing.state === 'failed'
      ? 'The repositories could not be listed: check Connect GitHub'
      : listing.repositories.length === 0
        ? 'No repository yet: connect GitHub and grant it repositories'
        : withoutOwn === 0
          ? `Every repository has its own ${own}`
          : `Give a repository its own ${own}…`

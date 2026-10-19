import { createHmac, createPrivateKey, timingSafeEqual } from 'node:crypto'
import type { AgentChat, PullRequestStep, RepositoryCheckouts } from '@hq/conversation/server'
import type { Database } from '@hq/db/postgres'
import {
  enteredSecretsOf,
  GitHubNotConfigured,
  GitHubRefused,
  type GitHubRepository,
  type GitHubSecrets,
  type GitHubSettingsInput,
  type GitHubSettingsView,
  githubSecretNames,
  githubSettingsFrom,
  InvalidGitHubSettings,
} from '@hq/workspace/server'
import type { SecretBox } from '../auth/secret-box.ts'
import { recordWorkspaceEvent, requireMemberPermission } from '../auth/sso.ts'
import { baseBundle, pushBundle } from './bundles.ts'
import { appJwtOf, type GitHubApi, type UserTokens } from './github-api.ts'
import {
  isSignedBy,
  pullRequestNumbersOf,
  pullRequestStepOf,
  updatedPullRequest,
  type WebhookPayload,
} from './webhooks.ts'

export type GitHubDependencies = { api: GitHubApi; secretBox?: SecretBox }
export type GitHubConnectionView = { login: string; state: 'connected' | 'needs_reconnection' }
type Member = { workspaceId: string; userId: string }
type AppRow = {
  appId: string
  clientId: string
  encryptedClientSecret: string
  encryptedPrivateKey: string
  encryptedWebhookSecret: string
}
type ConnectionState = { workspaceId: string; userId: string; databaseName?: string; expiresAt: number }

export const githubCallbackPath = '/auth/github/callback'
export const githubWebhooksPath = '/api/github/webhooks'
const connectionStateLifetimeMilliseconds = 10 * 60 * 1000
const secretLabels: Record<keyof GitHubSecrets, string> = {
  clientSecret: 'A client secret',
  privateKey: 'A private key',
  webhookSecret: 'A webhook secret',
}
const sealedColumns: Record<keyof GitHubSecrets, keyof AppRow> = {
  clientSecret: 'encryptedClientSecret',
  privateKey: 'encryptedPrivateKey',
  webhookSecret: 'encryptedWebhookSecret',
}

const githubCall = <Result>(work: () => Promise<Result>) =>
  work().catch((error: unknown) => {
    throw new GitHubRefused(error instanceof Error ? error.message : 'an unknown error')
  })

const appRowOf = async (database: Database, workspaceId: string) =>
  (
    await database.$client<AppRow[]>`
      select app_id as "appId", client_id as "clientId", encrypted_client_secret as "encryptedClientSecret",
        encrypted_private_key as "encryptedPrivateKey", encrypted_webhook_secret as "encryptedWebhookSecret"
      from github_apps where workspace_id = ${workspaceId}`
  )[0]

const appCredentialsOf = async (database: Database, { secretBox }: GitHubDependencies, workspaceId: string) => {
  const row = await appRowOf(database, workspaceId)
  if (!row || !secretBox) throw new GitHubNotConfigured()
  return {
    appId: row.appId,
    clientId: row.clientId,
    clientSecret: await secretBox.open(row.encryptedClientSecret),
    privateKey: await secretBox.open(row.encryptedPrivateKey),
  }
}

const repositoryTokenOf = async (
  api: GitHubApi,
  { appId, privateKey }: { appId: string; privateKey: string },
  fullName: string,
  permissions: Record<string, string>,
) => {
  const jwt = appJwtOf(appId, privateKey)
  const { id } = await api.repositoryInstallation(jwt, fullName)
  return api.installationToken(jwt, id, { repositories: [fullName.split('/')[1]], permissions })
}

export const grantedRepositories = async (
  database: Database,
  dependencies: GitHubDependencies,
  workspaceId: string,
): Promise<GitHubRepository[]> => {
  const { appId, privateKey } = await appCredentialsOf(database, dependencies, workspaceId)
  const { api } = dependencies
  return githubCall(async () => {
    const jwt = appJwtOf(appId, privateKey)
    const listed = await Promise.all(
      (await api.installations(jwt)).map(async ({ id }) =>
        api.installationRepositories(await api.installationToken(jwt, id, { permissions: { metadata: 'read' } })),
      ),
    )
    return listed
      .flatMap(({ repositories }) =>
        repositories.map((repository) => ({
          fullName: repository.full_name,
          defaultBranch: repository.default_branch,
        })),
      )
      .toSorted((first, second) => first.fullName.localeCompare(second.fullName))
  })
}

export const repositoryBranches = async (
  database: Database,
  dependencies: GitHubDependencies,
  workspaceId: string,
  fullName: string,
) => {
  const credentials = await appCredentialsOf(database, dependencies, workspaceId)
  return githubCall(async () => {
    const token = await repositoryTokenOf(dependencies.api, credentials, fullName, { metadata: 'read' })
    return (await dependencies.api.branches(token, fullName)).map(({ name }) => name)
  })
}

export const readGitHubSettings = async (
  database: Database,
  dependencies: GitHubDependencies,
  member: Member,
): Promise<GitHubSettingsView | null> => {
  await database.$client.begin((sql) => requireMemberPermission(sql, member, 'github.manage'))
  const row = await appRowOf(database, member.workspaceId)
  if (!row) return null
  const listing = await grantedRepositories(database, dependencies, member.workspaceId).then(
    (repositories) => ({ repositories, listingFailure: null }),
    (error: Error) => ({ repositories: [], listingFailure: error.message }),
  )
  return { appId: row.appId, clientId: row.clientId, ...listing }
}

export const saveGitHubSettings = async (
  database: Database,
  dependencies: GitHubDependencies,
  member: Member,
  input: GitHubSettingsInput,
) => {
  const { secretBox, api } = dependencies
  const settings = githubSettingsFrom(input)
  const entered = enteredSecretsOf(input)
  await database.$client.begin((sql) => requireMemberPermission(sql, member, 'github.manage'))
  const previous = await appRowOf(database, member.workspaceId)
  const missing = githubSecretNames.find((name) => !previous && !entered[name])
  if (missing) throw new InvalidGitHubSettings(`${secretLabels[missing]} is required`)
  if (!secretBox) throw new InvalidGitHubSettings('HQ_SECRETS_KEY is not set on this server')
  const privateKey = entered.privateKey ?? (await secretBox.open(previous?.encryptedPrivateKey ?? ''))
  try {
    createPrivateKey(privateKey)
  } catch {
    throw new InvalidGitHubSettings('The private key is not a PEM key')
  }
  await githubCall(() => api.app(appJwtOf(settings.appId, privateKey)))
  const sealed = Object.fromEntries(
    await Promise.all(
      githubSecretNames.map(async (name) => [
        sealedColumns[name],
        entered[name] ? await secretBox.seal(entered[name]) : previous?.[sealedColumns[name]],
      ]),
    ),
  ) as Pick<AppRow, 'encryptedClientSecret' | 'encryptedPrivateKey' | 'encryptedWebhookSecret'>
  await database.$client.begin(async (sql) => {
    await requireMemberPermission(sql, member, 'github.manage')
    await sql`
      insert into github_apps (workspace_id, app_id, client_id, encrypted_client_secret, encrypted_private_key,
        encrypted_webhook_secret, updated_at)
      values (${member.workspaceId}, ${settings.appId}, ${settings.clientId}, ${sealed.encryptedClientSecret},
        ${sealed.encryptedPrivateKey}, ${sealed.encryptedWebhookSecret}, now())
      on conflict (workspace_id) do update set app_id = excluded.app_id, client_id = excluded.client_id,
        encrypted_client_secret = excluded.encrypted_client_secret,
        encrypted_private_key = excluded.encrypted_private_key,
        encrypted_webhook_secret = excluded.encrypted_webhook_secret, updated_at = now()`
    if (previous?.appId !== settings.appId || previous.clientId !== settings.clientId)
      await recordWorkspaceEvent(sql, member.workspaceId, 'github.configured', member.userId, settings)
    if (previous && Object.keys(entered).length > 0)
      await recordWorkspaceEvent(sql, member.workspaceId, 'github.secret_rotated', member.userId, {
        secrets: Object.keys(entered),
      })
  })
  return readGitHubSettings(database, dependencies, member)
}

const signatureOf = (tokenSecret: string, payload: string) =>
  createHmac('sha256', tokenSecret).update(`github-connection.${payload}`).digest('base64url')

const signedStateOf = (tokenSecret: string, state: ConnectionState) => {
  const payload = Buffer.from(JSON.stringify(state)).toString('base64url')
  return `${payload}.${signatureOf(tokenSecret, payload)}`
}

const verifiedStateOf = (tokenSecret: string, signed: string) => {
  const [payload = '', signature = ''] = signed.split('.')
  const expected = Buffer.from(signatureOf(tokenSecret, payload))
  const given = Buffer.from(signature)
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return undefined
  const state = JSON.parse(Buffer.from(payload, 'base64url').toString()) as ConnectionState
  return state.expiresAt > Date.now() ? state : undefined
}

const storeUserTokens = async (
  database: Database,
  secretBox: SecretBox,
  { workspaceId, userId }: Member,
  login: string,
  { accessToken, refreshToken, accessExpiresAt }: UserTokens,
) => {
  const sealedAccessToken = await secretBox.seal(accessToken)
  const sealedRefreshToken = refreshToken ? await secretBox.seal(refreshToken) : null
  await database.$client`
    insert into github_connections (workspace_id, user_id, login, encrypted_access_token, encrypted_refresh_token,
      access_expires_at, needs_reconnection, updated_at)
    values (${workspaceId}, ${userId}, ${login}, ${sealedAccessToken}, ${sealedRefreshToken},
      ${accessExpiresAt?.toISOString() ?? null}::timestamptz,
      false, now())
    on conflict (workspace_id, user_id) do update set login = excluded.login,
      encrypted_access_token = excluded.encrypted_access_token,
      encrypted_refresh_token = excluded.encrypted_refresh_token, access_expires_at = excluded.access_expires_at,
      needs_reconnection = false, updated_at = now()`
}

export const githubConnectionOf = async (
  database: Database,
  dependencies: GitHubDependencies,
  member: Member,
): Promise<GitHubConnectionView | null> => {
  const [row] = await database.$client<
    { login: string; needsReconnection: boolean; encryptedRefreshToken: string | null; isExpired: boolean }[]
  >`
    select login, needs_reconnection as "needsReconnection", encrypted_refresh_token as "encryptedRefreshToken",
      coalesce(access_expires_at <= now(), false) as "isExpired"
    from github_connections where workspace_id = ${member.workspaceId} and user_id = ${member.userId}`
  if (!row) return null
  if (row.needsReconnection || !row.isExpired)
    return { login: row.login, state: row.needsReconnection ? 'needs_reconnection' : 'connected' }
  const { secretBox } = dependencies
  const refreshed =
    row.encryptedRefreshToken && secretBox
      ? await appCredentialsOf(database, dependencies, member.workspaceId)
          .then(async ({ clientId, clientSecret }) =>
            dependencies.api.refresh(clientId, clientSecret, await secretBox.open(row.encryptedRefreshToken ?? '')),
          )
          .catch(() => undefined)
      : undefined
  if (refreshed && secretBox) {
    await storeUserTokens(database, secretBox, member, row.login, refreshed)
    return { login: row.login, state: 'connected' }
  }
  await database.$client`
    update github_connections set needs_reconnection = true, updated_at = now()
    where workspace_id = ${member.workspaceId} and user_id = ${member.userId}`
  return { login: row.login, state: 'needs_reconnection' }
}

export const startGitHubConnection = async (
  database: Database,
  dependencies: GitHubDependencies,
  member: Member,
  { tokenSecret, callbackUrl, databaseName }: { tokenSecret: string; callbackUrl: string; databaseName?: string },
) => {
  const { clientId } = await appCredentialsOf(database, dependencies, member.workspaceId)
  const state = signedStateOf(tokenSecret, {
    workspaceId: member.workspaceId,
    userId: member.userId,
    databaseName,
    expiresAt: Date.now() + connectionStateLifetimeMilliseconds,
  })
  return { authorizeUrl: dependencies.api.authorizeUrlOf(clientId, callbackUrl, state) }
}

export const finishGitHubConnection = async (
  databaseOf: (databaseName: string | undefined) => Database | undefined,
  dependencies: GitHubDependencies,
  tokenSecret: string,
  { code, state }: { code: string; state: string },
) => {
  const verified = verifiedStateOf(tokenSecret, state)
  const database = verified && databaseOf(verified.databaseName)
  if (!verified || !database || !dependencies.secretBox) return false
  const { clientId, clientSecret } = await appCredentialsOf(database, dependencies, verified.workspaceId)
  const tokens = await dependencies.api.exchangeCode(clientId, clientSecret, code).catch(() => undefined)
  const login = tokens && (await dependencies.api.user(tokens.accessToken).catch(() => undefined))?.login
  if (!tokens || !login) return false
  await storeUserTokens(database, dependencies.secretBox, verified, login, tokens)
  return true
}

export const disconnectGitHub = (database: Database, member: Member) =>
  database.$client`
    delete from github_connections where workspace_id = ${member.workspaceId} and user_id = ${member.userId}`

const userTokenOf = async (database: Database, dependencies: GitHubDependencies, member: Member) => {
  const connection = await githubConnectionOf(database, dependencies, member)
  const [row] = await database.$client<{ encryptedAccessToken: string }[]>`
    select encrypted_access_token as "encryptedAccessToken" from github_connections
    where workspace_id = ${member.workspaceId} and user_id = ${member.userId}`
  return connection?.state === 'connected' && row && dependencies.secretBox?.open(row.encryptedAccessToken)
}

const chatRepositoryOf = async (database: Database, { workspaceId, chatId }: AgentChat) =>
  (
    await database.$client<{ repository: string | null; baseBranch: string | null; workingBranch: string | null }[]>`
      select repository, base_branch as "baseBranch", git_branch as "workingBranch"
      from chats where workspace_id = ${workspaceId} and id = ${chatId}`
  )[0]

export const createGitHubCheckouts = (database: Database, dependencies: GitHubDependencies): RepositoryCheckouts => {
  const { api } = dependencies
  const publishingOf = async (chat: AgentChat, ownerId: string) => {
    const { repository, baseBranch, workingBranch } = (await chatRepositoryOf(database, chat)) ?? {}
    const token = await userTokenOf(database, dependencies, { workspaceId: chat.workspaceId, userId: ownerId })
    if (!repository || !baseBranch || !workingBranch || !token) throw new GitHubNotConfigured()
    return { repository, baseBranch, workingBranch, token }
  }
  return {
    checkoutOf: async (chat) => {
      const { repository, baseBranch, workingBranch } = (await chatRepositoryOf(database, chat)) ?? {}
      if (!repository || !baseBranch || !workingBranch) return undefined
      const credentials = await appCredentialsOf(database, dependencies, chat.workspaceId)
      const token = await githubCall(() => repositoryTokenOf(api, credentials, repository, { contents: 'read' }))
      return { url: api.cloneUrlOf(repository), token, baseBranch, workingBranch }
    },
    pushBranch: async (chat, ownerId, bundleOf) => {
      const { repository, baseBranch, workingBranch } = (await chatRepositoryOf(database, chat)) ?? {}
      const token = await userTokenOf(database, dependencies, { workspaceId: chat.workspaceId, userId: ownerId })
      if (!repository || !baseBranch || !workingBranch || !token) return undefined
      const url = api.cloneUrlOf(repository)
      return {
        branch: workingBranch,
        ...(await pushBundle({ url, token, branch: workingBranch, baseBranch, bundleOf })),
      }
    },
    bundleBase: async (chat, runtimeBaseHead) => {
      const { repository, baseBranch } = (await chatRepositoryOf(database, chat)) ?? {}
      if (!repository || !baseBranch) throw new GitHubNotConfigured()
      const credentials = await appCredentialsOf(database, dependencies, chat.workspaceId)
      const token = await githubCall(() => repositoryTokenOf(api, credentials, repository, { contents: 'read' }))
      return baseBundle({ url: api.cloneUrlOf(repository), token, baseBranch, runtimeBaseHead })
    },
    authorOf: async (chat, ownerId) => {
      const token = await userTokenOf(database, dependencies, { workspaceId: chat.workspaceId, userId: ownerId })
      const user = token ? await api.user(token).catch(() => undefined) : undefined
      return (
        user && {
          name: user.name || user.login,
          email: user.email || `${user.id}+${user.login}@users.noreply.github.com`,
        }
      )
    },
    openPullRequest: async (chat, ownerId, { title, body }) => {
      const { repository, baseBranch, workingBranch, token } = await publishingOf(chat, ownerId)
      return githubCall(async () =>
        pullRequestStepOf(
          repository,
          await api.createPullRequest(token, repository, { title, body, head: workingBranch, base: baseBranch }),
        ),
      )
    },
    refreshPullRequest: async (chat, ownerId, pullRequest) => {
      const { token } = await publishingOf(chat, ownerId)
      return githubCall(async () =>
        pullRequestStepOf(
          pullRequest.repository,
          await api.pullRequest(token, pullRequest.repository, pullRequest.number),
          pullRequest,
        ),
      )
    },
  }
}

type PullRequestCard = { workspaceId: string; chatId: string; id: string; step: PullRequestStep }
type WebhookDelivery = { appId?: string; event?: string; deliveryId?: string; signature?: string; body: string }

export const receiveGitHubWebhook = async (
  database: Database,
  { secretBox }: GitHubDependencies,
  { appId, event = '', deliveryId = '', signature, body }: WebhookDelivery,
  record: (card: PullRequestCard, step: PullRequestStep) => Promise<unknown>,
) => {
  const apps = await database.$client<{ workspaceId: string; encryptedWebhookSecret: string }[]>`
    select workspace_id as "workspaceId", encrypted_webhook_secret as "encryptedWebhookSecret" from github_apps
    where ${appId ? database.$client`app_id = ${appId}` : database.$client`true`}`
  const signedBy = await Promise.all(
    apps.map(async (app) => secretBox && isSignedBy(await secretBox.open(app.encryptedWebhookSecret), body, signature)),
  )
  const workspaceId = apps.find((_, index) => signedBy[index])?.workspaceId
  if (!workspaceId || !deliveryId) return 'refused'
  const [delivered] = await database.$client`
    insert into github_webhook_deliveries (workspace_id, delivery_id, received_at)
    values (${workspaceId}, ${deliveryId}, now()) on conflict do nothing returning 1`
  if (!delivered) return 'duplicate'
  const payload = JSON.parse(body) as WebhookPayload
  const numbers = pullRequestNumbersOf(event, payload).map(String)
  const cards = await database.$client<PullRequestCard[]>`
    select workspace_id as "workspaceId", chat_id as "chatId", id, step from messages
    where workspace_id = ${workspaceId} and step->>'type' = 'pull_request'
      and step->>'repository' = ${payload.repository?.full_name ?? ''} and step->>'number' = any(${numbers})`
  for (const card of cards) {
    const step = updatedPullRequest(card.step, event, payload)
    if (JSON.stringify(step) !== JSON.stringify(card.step)) await record(card, step)
  }
  return cards.length > 0 ? 'applied' : 'ignored'
}

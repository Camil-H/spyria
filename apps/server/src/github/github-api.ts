import { createPrivateKey, createSign } from 'node:crypto'
import type { GitHubPullRequest } from './webhooks.ts'

export type GitHubUrls = { apiUrl: string; webUrl: string }
export type UserTokens = { accessToken: string; refreshToken: string | null; accessExpiresAt: Date | null }
type Installation = { id: number }
type Requested = { token: string; method?: string; body?: object }

export const githubDotCom: GitHubUrls = { apiUrl: 'https://api.github.com', webUrl: 'https://github.com' }
const requestTimeoutMilliseconds = 15_000
const jwtLifetimeSeconds = 540
const clockSkewSeconds = 60

export class GitHubRequestFailed extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

const base64urlOf = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url')

export const appJwtOf = (appId: string, privateKey: string, now = Date.now()) => {
  const issuedAt = Math.floor(now / 1000) - clockSkewSeconds
  const unsigned = `${base64urlOf({ alg: 'RS256', typ: 'JWT' })}.${base64urlOf({ iat: issuedAt, exp: issuedAt + jwtLifetimeSeconds, iss: appId })}`
  return `${unsigned}.${createSign('RSA-SHA256').update(unsigned).sign(createPrivateKey(privateKey), 'base64url')}`
}

export const createGitHubApi = ({ apiUrl, webUrl }: GitHubUrls) => {
  const request = async <Result>(path: string, { token, method = 'GET', body }: Requested) => {
    const response = await fetch(`${apiUrl}${path}`, {
      method,
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
        'x-github-api-version': '2022-11-28',
        ...(body && { 'content-type': 'application/json' }),
      },
      body: body && JSON.stringify(body),
      signal: AbortSignal.timeout(requestTimeoutMilliseconds),
    })
    if (!response.ok) {
      const { message } = (await response.json().catch(() => ({}))) as { message?: string }
      throw new GitHubRequestFailed(response.status, `${response.status} ${message ?? response.statusText}`)
    }
    return (await response.json()) as Result
  }
  const userTokensOf = async (parameters: Record<string, string>): Promise<UserTokens> => {
    const response = await fetch(`${webUrl}/login/oauth/access_token`, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(parameters),
      signal: AbortSignal.timeout(requestTimeoutMilliseconds),
    })
    const tokens = (await response.json().catch(() => ({}))) as Record<string, string | number | undefined>
    if (!response.ok || typeof tokens.access_token !== 'string')
      throw new GitHubRequestFailed(response.status, String(tokens.error ?? response.statusText))
    return {
      accessToken: tokens.access_token,
      refreshToken: typeof tokens.refresh_token === 'string' ? tokens.refresh_token : null,
      accessExpiresAt: typeof tokens.expires_in === 'number' ? new Date(Date.now() + tokens.expires_in * 1000) : null,
    }
  }
  return {
    app: (jwt: string) => request<{ id: number }>('/app', { token: jwt }),
    installations: (jwt: string) => request<Installation[]>('/app/installations?per_page=100', { token: jwt }),
    repositoryInstallation: (jwt: string, fullName: string) =>
      request<Installation>(`/repos/${fullName}/installation`, { token: jwt }),
    installationToken: async (jwt: string, installationId: number, scope?: object) =>
      (
        await request<{ token: string }>(`/app/installations/${installationId}/access_tokens`, {
          token: jwt,
          method: 'POST',
          body: scope ?? {},
        })
      ).token,
    installationRepositories: (token: string) =>
      request<{ repositories: { full_name: string; default_branch: string }[] }>(
        '/installation/repositories?per_page=100',
        { token },
      ),
    branches: (token: string, fullName: string) =>
      request<{ name: string }[]>(`/repos/${fullName}/branches?per_page=100`, { token }),
    user: (token: string) =>
      request<{ login: string; id: number; name: string | null; email: string | null }>('/user', { token }),
    authorizeUrlOf: (clientId: string, redirectUri: string, state: string) =>
      `${webUrl}/login/oauth/authorize?${new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, state })}`,
    exchangeCode: (clientId: string, clientSecret: string, code: string) =>
      userTokensOf({ client_id: clientId, client_secret: clientSecret, code }),
    refresh: (clientId: string, clientSecret: string, refreshToken: string) =>
      userTokensOf({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
      }),
    createPullRequest: (
      token: string,
      fullName: string,
      body: { title: string; body: string; head: string; base: string },
    ) => request<GitHubPullRequest>(`/repos/${fullName}/pulls`, { token, method: 'POST', body }),
    pullRequest: (token: string, fullName: string, number: number) =>
      request<GitHubPullRequest>(`/repos/${fullName}/pulls/${number}`, { token }),
    cloneUrlOf: (fullName: string) => `${webUrl}/${fullName}.git`,
  }
}

export type GitHubApi = ReturnType<typeof createGitHubApi>

import type { WorkspaceSession } from '@spyria/db/zero-store'
import type { MemberId, WorkspaceId } from '@spyria/kernel'

export type SignInProvider = { id: string; kind: 'google' | 'microsoft' | 'oidc'; isWorkspaceSso: boolean }
type SignInResult =
  | { status: 'signed_in' }
  | { status: 'not_invited'; email: string }
  | { status: 'no_workspace' }
  | { status: 'failed' }
  | { status: 'closed' }
  | { status: 'refused'; message: string }
  | { status: 'choose_provider'; providers: SignInProvider[] }

const popupPollMilliseconds = 200
const popupName = 'spyria-sign-in'
const csrfHeaders = { 'content-type': 'application/json', 'x-spyria-csrf': '1' }

const postAuth = (path: string, workspaceId: WorkspaceId, headers: Record<string, string> = {}) =>
  fetch(path, { method: 'POST', headers: { ...csrfHeaders, ...headers }, body: JSON.stringify({ workspaceId }) })

export class ServerUnreachable extends Error {}

const authJsonOf = async (path: string) => {
  try {
    const response = await fetch(path)
    if (!response.ok) throw new Error(`answered ${response.status}`)
    return await response.json()
  } catch (error) {
    throw new ServerUnreachable(`${new URL(path, location.origin).pathname} could not be read`, { cause: error })
  }
}

export const loadSessions = async (): Promise<
  | { userId?: undefined; sessions: [] }
  | { userId: MemberId; sessions: WorkspaceSession[]; deployment: string; version: string; hostImage?: string }
> => authJsonOf('/auth/sessions')

export const loadAuthMode = async (
  setupToken?: string,
): Promise<{
  authMode: 'dex' | 'sso'
  isBeingSetUp: boolean
  canCreateWorkspace: boolean
  accountProviders: ('google' | 'microsoft' | 'oidc')[]
  callbackOrigin: string
  instanceApps: ('google' | 'microsoft')[]
}> => authJsonOf(setupToken ? `/auth/mode?${new URLSearchParams({ setup: setupToken })}` : '/auth/mode')

let sharedAuthModeLoading: ReturnType<typeof loadAuthMode> | undefined
export const sharedAuthMode = () => {
  sharedAuthModeLoading ??= loadAuthMode()
  return sharedAuthModeLoading
}

export const renew = async (workspaceId: WorkspaceId): Promise<WorkspaceSession | undefined> => {
  const response = await postAuth('/auth/renew', workspaceId)
  if (response.status === 401 || response.status === 403) return undefined
  if (!response.ok) throw new Error(`Renewing the session of ${workspaceId} failed with ${response.status}`)
  return response.json()
}

export const logOut = (workspaceId: WorkspaceId) => postAuth('/auth/logout', workspaceId)

export const openSession = async (workspaceId: WorkspaceId, bearerToken: string): Promise<WorkspaceSession> => {
  const response = await postAuth('/auth/sessions', workspaceId, { authorization: `Bearer ${bearerToken}` })
  if (!response.ok) throw new Error(`Opening a session in ${workspaceId} failed with ${response.status}`)
  return response.json()
}

const isFromSpyria = async ({ origin }: MessageEvent) =>
  origin === location.origin || origin === (await sharedAuthMode()).callbackOrigin

const resultOf = (popup: Window | null) =>
  new Promise<SignInResult>((resolve) => {
    if (!popup) return resolve({ status: 'closed' })
    const settle = (result: SignInResult) => {
      clearInterval(closedPoll)
      window.removeEventListener('message', receive)
      resolve(result)
    }
    const receive = async (event: MessageEvent) => {
      if (event.source !== popup || !(await isFromSpyria(event))) return
      popup.close()
      settle(event.data)
    }
    const settleIfClosed = () => popup.closed && setTimeout(settle, popupPollMilliseconds, { status: 'closed' })
    const closedPoll = setInterval(settleIfClosed, popupPollMilliseconds)
    window.addEventListener('message', receive)
  })

const openPopup = (url: string) => window.open(url, popupName, 'popup,width=480,height=640')
const loginUrlOf = (target: Record<string, string | undefined>) =>
  `/auth/login?${new URLSearchParams(Object.entries(target).filter((entry): entry is [string, string] => !!entry[1]))}`

export const signInWithPopup = (target: { workspace?: WorkspaceId; email?: string; provider?: string } = {}) =>
  resultOf(openPopup(loginUrlOf(target)))

export const signInWithEmail = async (email: string): Promise<SignInResult> => {
  const popup = openPopup('')
  const response = await fetch(`/auth/providers?${new URLSearchParams({ email })}`).catch(() => undefined)
  const { providers = [] }: { providers?: SignInProvider[] } = response?.ok ? await response.json() : {}
  const [onlyProvider] = providers
  if (popup && onlyProvider && providers.length === 1) {
    popup.location.href = loginUrlOf({ email, provider: onlyProvider.id })
    return resultOf(popup)
  }
  popup?.close()
  if (!response?.ok) return { status: 'failed' }
  return providers.length === 0 ? { status: 'not_invited', email } : { status: 'choose_provider', providers }
}

export const submitInPopup = (form: HTMLFormElement, action: string) => {
  const popup = openPopup('')
  Object.assign(form, { method: 'post', action, target: popupName }).submit()
  return resultOf(popup)
}

export const createWorkspaceOfAccount = async (name: string): Promise<WorkspaceSession> => {
  const response = await fetch('/auth/workspaces', {
    method: 'POST',
    headers: csrfHeaders,
    body: JSON.stringify({ name }),
  })
  const body = await response.json().catch(() => ({}))
  if (response.status === 401) throw new Error('Your sign-in expired: sign in again to create a workspace')
  if (!response.ok) throw new Error(body.message ?? 'The workspace could not be created. Try again.')
  return body
}

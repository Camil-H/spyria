import type { WorkspaceSession } from '@spyria/db/zero-store'
import type { MemberId, WorkspaceId } from '@spyria/kernel'

type SignInResult =
  | { status: 'signed_in' }
  | { status: 'not_invited'; email: string }
  | { status: 'unknown_domain'; domain: string }
  | { status: 'failed' }
  | { status: 'closed' }
  | { status: 'refused'; message: string }

const popupPollMilliseconds = 200
const popupName = 'spyria-sign-in'

const postAuth = (path: string, workspaceId: WorkspaceId, headers: Record<string, string> = {}) =>
  fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-spyria-csrf': '1', ...headers },
    body: JSON.stringify({ workspaceId }),
  })

export const loadSessions = async (): Promise<{ userId?: MemberId; sessions: WorkspaceSession[] }> =>
  (await fetch('/auth/sessions')).json()

export const loadAuthMode = async (): Promise<{ authMode: 'dex' | 'sso'; canCreateWorkspace: boolean }> =>
  (await fetch('/auth/mode')).json()

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

const resultOf = (popup: Window | null) =>
  new Promise<SignInResult>((resolve) => {
    if (!popup) return resolve({ status: 'closed' })
    const settle = (result: SignInResult) => {
      clearInterval(closedPoll)
      window.removeEventListener('message', receive)
      resolve(result)
    }
    const receive = (event: MessageEvent) => {
      if (event.source === popup) settle(event.data)
    }
    const settleIfClosed = () => popup.closed && setTimeout(settle, popupPollMilliseconds, { status: 'closed' })
    const closedPoll = setInterval(settleIfClosed, popupPollMilliseconds)
    window.addEventListener('message', receive)
  })

const openPopup = (url: string) => window.open(url, popupName, 'popup,width=480,height=640')

export const signInWithPopup = (target: { workspace?: WorkspaceId; email?: string } = {}) => {
  const query = new URLSearchParams(Object.entries(target).filter((entry): entry is [string, string] => !!entry[1]))
  return resultOf(openPopup(`/auth/login?${query}`))
}

export const createWorkspaceWithPopup = (form: HTMLFormElement) => {
  const popup = openPopup('')
  Object.assign(form, { method: 'post', action: '/auth/first-workspace', target: popupName }).submit()
  return resultOf(popup)
}

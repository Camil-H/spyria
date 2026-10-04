import type { WorkspaceSession } from '@hq/db/zero-store'
import type { MemberId, WorkspaceId } from '@hq/kernel'

export type SignInResult =
  | { status: 'signed_in' }
  | { status: 'not_invited'; email: string }
  | { status: 'failed' }
  | { status: 'closed' }

const popupPollMilliseconds = 200

const postAuth = (path: string, workspaceId: WorkspaceId, headers: Record<string, string> = {}) =>
  fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-hq-csrf': '1', ...headers },
    body: JSON.stringify({ workspaceId }),
  })

export const loadSessions = async (): Promise<{ userId?: MemberId; sessions: WorkspaceSession[] }> =>
  (await fetch('/auth/sessions')).json()

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

export const signInWithPopup = (workspaceId?: WorkspaceId) =>
  new Promise<SignInResult>((resolve) => {
    const query = workspaceId === undefined ? '' : `?workspace=${encodeURIComponent(workspaceId)}`
    const popup = window.open(`/auth/login${query}`, 'hq-sign-in', 'popup,width=480,height=640')
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

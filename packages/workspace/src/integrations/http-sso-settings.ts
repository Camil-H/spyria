import { refusalOf, type WorkspaceId } from '@spyria/kernel'
import type { SsoSettingsView } from '../domain/sso.ts'

export const ssoSettingsPath = '/api/sso-settings'
export const ssoStopPath = `${ssoSettingsPath}/stop`

type PostAsMember = (workspaceId: WorkspaceId, path: string, body?: string) => Promise<Response>
type GetAsMember = (workspaceId: WorkspaceId, path: string) => Promise<Response>

const bodyOf = async (response: Response) => {
  const body = (await response.json().catch(() => ({}))) as {
    settings?: SsoSettingsView | null
    error?: string
    message?: string
  }
  if (!response.ok) throw refusalOf(response.status, body)
  return body
}

export const createHttpSsoSettingsCommands = (postAsMember: PostAsMember, getAsMember: GetAsMember) => ({
  readSsoSettings: async ({ workspaceId }: { workspaceId: WorkspaceId }) =>
    (await bodyOf(await getAsMember(workspaceId, ssoSettingsPath))).settings ?? null,
  stopSso: async ({ workspaceId }: { workspaceId: WorkspaceId }) => {
    await bodyOf(await postAsMember(workspaceId, ssoStopPath))
  },
})

import { refusalOf, type WorkspaceId } from '@spyria/kernel'
import type { SsoSettingsView, SsoSuggestion } from '../domain/sso.ts'

export const ssoSettingsPath = '/api/sso-settings'
export const ssoStopPath = `${ssoSettingsPath}/stop`
export const ssoOtherDomainsPath = `${ssoSettingsPath}/other-domains`

type PostAsMember = (workspaceId: WorkspaceId, path: string, body?: string) => Promise<Response>
type GetAsMember = (workspaceId: WorkspaceId, path: string) => Promise<Response>

const bodyOf = async <Body extends object>(response: Response) => {
  const body = (await response.json().catch(() => ({}))) as Body & { error?: string; message?: string }
  if (!response.ok) throw refusalOf(response.status, body)
  return body
}

export const createHttpSsoSettingsCommands = (postAsMember: PostAsMember, getAsMember: GetAsMember) => ({
  readSsoSettings: async ({ workspaceId }: { workspaceId: WorkspaceId }) => {
    const { settings = null, suggestion } = await bodyOf<{
      settings?: SsoSettingsView | null
      suggestion?: SsoSuggestion
    }>(await getAsMember(workspaceId, ssoSettingsPath))
    return { settings, suggestion }
  },
  readAddressesAtOtherDomains: async ({ workspaceId }: { workspaceId: WorkspaceId }) => {
    const { addresses = [], count = 0 } = await bodyOf<{ addresses?: string[]; count?: number }>(
      await getAsMember(workspaceId, ssoOtherDomainsPath),
    )
    return { addresses, count }
  },
  stopSso: async ({ workspaceId }: { workspaceId: WorkspaceId }) => {
    await bodyOf(await postAsMember(workspaceId, ssoStopPath))
  },
})

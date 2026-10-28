import { refusalOf, type WorkspaceId } from '@spyria/kernel'
import type { SsoSettingsInput, SsoSettingsView } from '../domain/sso.ts'

export const ssoSettingsPath = '/api/sso-settings'
export const domainVerificationPath = `${ssoSettingsPath}/domain-verification`

type PostAsMember = (workspaceId: WorkspaceId, path: string, body?: string) => Promise<Response>
type GetAsMember = (workspaceId: WorkspaceId, path: string) => Promise<Response>

const settingsOf = async (response: Response) => {
  const body = (await response.json().catch(() => ({}))) as {
    settings?: SsoSettingsView | null
    error?: string
    message?: string
  }
  if (!response.ok) throw refusalOf(response.status, body)
  return body.settings ?? null
}

export const createHttpSsoSettingsCommands = (postAsMember: PostAsMember, getAsMember: GetAsMember) => ({
  readSsoSettings: async ({ workspaceId }: { workspaceId: WorkspaceId }) =>
    settingsOf(await getAsMember(workspaceId, ssoSettingsPath)),
  saveSsoSettings: async ({ workspaceId, ...input }: SsoSettingsInput & { workspaceId: WorkspaceId }) =>
    settingsOf(await postAsMember(workspaceId, ssoSettingsPath, JSON.stringify(input))),
  sendDomainVerification: async ({
    workspaceId,
    domain,
    email,
  }: {
    workspaceId: WorkspaceId
    domain: string
    email: string
  }) => settingsOf(await postAsMember(workspaceId, domainVerificationPath, JSON.stringify({ domain, email }))),
})

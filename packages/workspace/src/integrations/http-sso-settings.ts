import { DomainError, type WorkspaceId } from '@hq/kernel'
import type { SsoSettingsInput, SsoSettingsView } from '../domain/sso.ts'

export const ssoSettingsPath = '/api/sso-settings'

type PostAsMember = (workspaceId: WorkspaceId, path: string, body?: string) => Promise<Response>
type GetAsMember = (workspaceId: WorkspaceId, path: string) => Promise<Response>

const settingsOf = async (response: Response) => {
  const body = (await response.json().catch(() => ({}))) as {
    settings?: SsoSettingsView | null
    error?: string
    message?: string
  }
  if (!response.ok)
    throw new DomainError(body.error ?? 'internal', body.message ?? `The request was refused with ${response.status}`)
  return body.settings ?? null
}

export const createHttpSsoSettingsCommands = (postAsMember: PostAsMember, getAsMember: GetAsMember) => ({
  readSsoSettings: async ({ workspaceId }: { workspaceId: WorkspaceId }) =>
    settingsOf(await getAsMember(workspaceId, ssoSettingsPath)),
  saveSsoSettings: async ({ workspaceId, ...input }: SsoSettingsInput & { workspaceId: WorkspaceId }) =>
    settingsOf(await postAsMember(workspaceId, ssoSettingsPath, JSON.stringify(input))),
})

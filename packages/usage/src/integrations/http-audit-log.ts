import { refusalOf, type WorkspaceId } from '@spyria/kernel'
import type { AuditPage } from '../domain/audit.ts'

export const auditLogPath = '/api/audit-log'
export const auditCsvPath = `${auditLogPath}/csv`
export const auditRetentionPath = `${auditLogPath}/retention`

type PostAsMember = (workspaceId: WorkspaceId, path: string, body?: string) => Promise<Response>
type GetAsMember = (workspaceId: WorkspaceId, path: string) => Promise<Response>
type AuditSearch = Readonly<Record<string, string>>

export const succeeded = async (response: Response) => {
  if (response.ok) return response
  throw refusalOf(response.status, await response.json().catch(() => ({})))
}
const withSearch = (path: string, search: AuditSearch) => `${path}?${new URLSearchParams(search)}`
const retentionOf = async (response: Response) =>
  ((await (await succeeded(response)).json()) as { retentionDays: number | null }).retentionDays

export const createHttpAuditLogCommands = (postAsMember: PostAsMember, getAsMember: GetAsMember) => ({
  readAuditPage: async ({ workspaceId, search }: { workspaceId: WorkspaceId; search: AuditSearch }) =>
    (await (await succeeded(await getAsMember(workspaceId, withSearch(auditLogPath, search)))).json()) as AuditPage,
  exportAuditCsv: async ({ workspaceId, search }: { workspaceId: WorkspaceId; search: AuditSearch }) =>
    (await succeeded(await getAsMember(workspaceId, withSearch(auditCsvPath, search)))).blob(),
  readAuditRetention: async ({ workspaceId }: { workspaceId: WorkspaceId }) =>
    retentionOf(await getAsMember(workspaceId, auditRetentionPath)),
  saveAuditRetention: async ({
    workspaceId,
    retentionDays,
  }: {
    workspaceId: WorkspaceId
    retentionDays: number | null
  }) => retentionOf(await postAsMember(workspaceId, auditRetentionPath, JSON.stringify({ retentionDays }))),
})

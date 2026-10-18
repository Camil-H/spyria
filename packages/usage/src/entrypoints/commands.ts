import type { WorkspaceId } from '@hq/kernel'
import type { AuditPage } from '../domain/audit.ts'

type AuditRequest = { workspaceId: WorkspaceId; search: Readonly<Record<string, string>> }

export type UsageCommands = {
  readAuditPage: (input: AuditRequest) => Promise<AuditPage>
  exportAuditCsv: (input: AuditRequest) => Promise<Blob>
  readAuditRetention: (input: { workspaceId: WorkspaceId }) => Promise<number | null>
  saveAuditRetention: (input: { workspaceId: WorkspaceId; retentionDays: number | null }) => Promise<number | null>
}

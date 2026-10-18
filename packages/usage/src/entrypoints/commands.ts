import type { WorkspaceId } from '@hq/kernel'
import type { AuditPage } from '../domain/audit.ts'
import type { SpendReport } from '../domain/spend.ts'

type SearchRequest = { workspaceId: WorkspaceId; search: Readonly<Record<string, string>> }

export type UsageCommands = {
  readAuditPage: (input: SearchRequest) => Promise<AuditPage>
  exportAuditCsv: (input: SearchRequest) => Promise<Blob>
  readAuditRetention: (input: { workspaceId: WorkspaceId }) => Promise<number | null>
  readWorkspaceSpend: (input: SearchRequest) => Promise<SpendReport>
  readOwnSpend: (input: SearchRequest) => Promise<SpendReport>
  saveAuditRetention: (input: { workspaceId: WorkspaceId; retentionDays: number | null }) => Promise<number | null>
}

import type { MemberId, WorkspaceId } from '@spyria/kernel'
import type { AuditPage } from '../domain/audit.ts'
import type { BudgetOverview, BudgetProgress } from '../domain/budgets.ts'
import type { SpendReport } from '../domain/spend.ts'

type SearchRequest = { workspaceId: WorkspaceId; search: Readonly<Record<string, string>> }

export type UsageCommands = {
  readAuditPage: (input: SearchRequest) => Promise<AuditPage>
  exportAuditCsv: (input: SearchRequest) => Promise<Blob>
  readAuditRetention: (input: { workspaceId: WorkspaceId }) => Promise<number | null>
  readWorkspaceSpend: (input: SearchRequest) => Promise<SpendReport>
  readOwnSpend: (input: SearchRequest) => Promise<SpendReport>
  readBudgets: (input: { workspaceId: WorkspaceId }) => Promise<BudgetOverview>
  saveBudget: (input: {
    workspaceId: WorkspaceId
    memberId: MemberId | null
    dollars: number | null
  }) => Promise<BudgetOverview>
  readOwnBudget: (input: { workspaceId: WorkspaceId }) => Promise<BudgetProgress>
  saveAuditRetention: (input: { workspaceId: WorkspaceId; retentionDays: number | null }) => Promise<number | null>
}

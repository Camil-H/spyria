import type { WorkspaceId } from '@spyria/kernel'
import type { AuditPage } from '../domain/audit.ts'
import type { BudgetOverview, BudgetPeriod, PeriodBudget } from '../domain/budgets.ts'
import type { SpendBucketCounts, SpendReport } from '../domain/spend.ts'

type SearchRequest = { workspaceId: WorkspaceId; search: Readonly<Record<string, string>> }

export type UsageCommands = {
  readAuditPage: (input: SearchRequest) => Promise<AuditPage>
  exportAuditCsv: (input: SearchRequest) => Promise<Blob>
  readAuditRetention: (input: { workspaceId: WorkspaceId }) => Promise<number | null>
  readWorkspaceSpend: (input: SearchRequest) => Promise<SpendReport>
  readOwnSpend: (input: SearchRequest) => Promise<SpendReport>
  readWorkspaceSpendTrend: (input: SearchRequest) => Promise<SpendBucketCounts[]>
  readOwnSpendTrend: (input: SearchRequest) => Promise<SpendBucketCounts[]>
  readBudgets: (input: { workspaceId: WorkspaceId }) => Promise<BudgetOverview>
  saveRoleBudget: (input: {
    workspaceId: WorkspaceId
    roleId: string
    dollars: Readonly<Record<BudgetPeriod, number | null>>
  }) => Promise<BudgetOverview>
  readOwnBudget: (input: { workspaceId: WorkspaceId }) => Promise<PeriodBudget[]>
  saveAuditRetention: (input: { workspaceId: WorkspaceId; retentionDays: number | null }) => Promise<number | null>
}

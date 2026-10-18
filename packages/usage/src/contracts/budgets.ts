import type { MemberId, Transactor } from '@hq/kernel'
import type { BudgetAlert, BudgetChange, BudgetUse, MemberSpend } from '../domain/budgets.ts'

export type BudgetLedger = {
  isActiveAdmin(memberId: MemberId): Promise<boolean>
  uses(since: Date, memberId: MemberId | null): Promise<BudgetUse[]>
  memberSpends(since: Date, memberId: MemberId | null): Promise<MemberSpend[]>
  workspaceSpentMicros(since: Date): Promise<number>
  setBudget(change: BudgetChange, actorId: MemberId): Promise<void>
  clearAlerts(memberId: MemberId | null, month: string): Promise<void>
  recordAlerts(month: string, alerts: readonly BudgetAlert[]): Promise<void>
}

export type BudgetTransactor = Transactor<BudgetLedger>

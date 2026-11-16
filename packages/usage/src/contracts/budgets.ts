import type { MemberId, Transactor, WorkspacePermission } from '@spyria/kernel'
import type { BudgetAlert, BudgetPeriod, MemberPeriodSpend, RoleBudget, RoleBudgetChange } from '../domain/budgets.ts'

export type BudgetLedger = {
  permissions(memberId: MemberId): Promise<readonly WorkspacePermission[]>
  roleBudgets(): Promise<RoleBudget[]>
  memberSpends(
    periodStarts: Readonly<Record<BudgetPeriod, Date>>,
    memberId: MemberId | null,
  ): Promise<MemberPeriodSpend[]>
  setRoleBudget(change: RoleBudgetChange, changedPeriods: readonly BudgetPeriod[], actorId: MemberId): Promise<void>
  clearRoleAlerts(roleId: string, periods: readonly { period: BudgetPeriod; startsOn: string }[]): Promise<void>
  recordAlerts(alerts: readonly BudgetAlert[]): Promise<void>
}

export type BudgetTransactor = Transactor<BudgetLedger>

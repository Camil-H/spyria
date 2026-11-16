import { type MemberId, requireWorkspacePermission } from '@spyria/kernel'
import type { BudgetLedger, BudgetTransactor } from '../contracts/budgets.ts'
import {
  type BudgetOverview,
  budgetAlertsOf,
  budgetOverviewOf,
  changedPeriodsOf,
  ownBudgetsOf,
  periodStartsOf,
  roleBudgetChangeFrom,
  startsOnOf,
  usedUpPeriodOf,
} from '../domain/budgets.ts'
import { BudgetRoleNotFound } from '../domain/errors.ts'

type Dependencies = { transactor: BudgetTransactor }

const overviewOf = async (ledger: BudgetLedger, now: Date) =>
  budgetOverviewOf(await ledger.roleBudgets(), await ledger.memberSpends(periodStartsOf(now), null))

const recordReachedAlerts = async (ledger: BudgetLedger, now: Date) =>
  ledger.recordAlerts(budgetAlertsOf(await ledger.memberSpends(periodStartsOf(now), null), now))

export const readBudgets = ({ transactor }: Dependencies, { memberId, now }: { memberId: MemberId; now: Date }) =>
  transactor.run(async (ledger): Promise<BudgetOverview> => {
    await requireWorkspacePermission(ledger, memberId, 'budgets.manage')
    return overviewOf(ledger, now)
  })

export const setRoleBudget = (
  { transactor }: Dependencies,
  { memberId, budget, now }: { memberId: MemberId; budget: unknown; now: Date },
) =>
  transactor.run(async (ledger): Promise<BudgetOverview> => {
    await requireWorkspacePermission(ledger, memberId, 'budgets.manage')
    const change = roleBudgetChangeFrom(budget)
    const current = (await ledger.roleBudgets()).find((role) => role.roleId === change.roleId)
    if (!current) throw new BudgetRoleNotFound()
    const changedPeriods = changedPeriodsOf(current.limits, change.limits)
    if (changedPeriods.length === 0) return overviewOf(ledger, now)
    await ledger.setRoleBudget(change, changedPeriods, memberId)
    await ledger.clearRoleAlerts(
      change.roleId,
      changedPeriods.map((period) => ({ period, startsOn: startsOnOf(period, now) })),
    )
    await recordReachedAlerts(ledger, now)
    return overviewOf(ledger, now)
  })

export const readOwnBudget = ({ transactor }: Dependencies, { memberId, now }: { memberId: MemberId; now: Date }) =>
  transactor.run(async (ledger) => ownBudgetsOf(await ledger.memberSpends(periodStartsOf(now), memberId)))

export const findUsedUpBudget = ({ transactor }: Dependencies, { memberId, now }: { memberId: MemberId; now: Date }) =>
  transactor.run(async (ledger) => usedUpPeriodOf(await ledger.memberSpends(periodStartsOf(now), memberId)))

export const recordBudgetAlerts = ({ transactor }: Dependencies, { now }: { now: Date }) =>
  transactor.run((ledger) => recordReachedAlerts(ledger, now))

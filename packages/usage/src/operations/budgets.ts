import { type MemberId, requireWorkspacePermission } from '@spyria/kernel'
import type { BudgetLedger, BudgetTransactor } from '../contracts/budgets.ts'
import {
  type BudgetOverview,
  budgetAlertsOf,
  budgetChangeFrom,
  budgetOverviewOf,
  budgetProgressOf,
  monthOf,
  monthStartOf,
  usedUpBudgetOf,
} from '../domain/budgets.ts'
import { BudgetMemberNotFound } from '../domain/errors.ts'

type Dependencies = { transactor: BudgetTransactor }

const overviewOf = async (ledger: BudgetLedger, now: Date) => {
  const since = monthStartOf(now)
  const workspaceUse = (await ledger.uses(since, null)).find((use) => use.memberId === null)
  return budgetOverviewOf(await ledger.memberSpends(since, null), {
    limitMicros: workspaceUse?.limitMicros ?? null,
    spentMicros: await ledger.workspaceSpentMicros(since),
  })
}

const recordReachedAlerts = async (ledger: BudgetLedger, now: Date) =>
  ledger.recordAlerts(monthOf(now), budgetAlertsOf(await ledger.uses(monthStartOf(now), null)))

export const readBudgets = ({ transactor }: Dependencies, { memberId, now }: { memberId: MemberId; now: Date }) =>
  transactor.run(async (ledger): Promise<BudgetOverview> => {
    await requireWorkspacePermission(ledger, memberId, 'budgets.manage')
    return overviewOf(ledger, now)
  })

export const setBudget = (
  { transactor }: Dependencies,
  { memberId, budget, now }: { memberId: MemberId; budget: unknown; now: Date },
) =>
  transactor.run(async (ledger): Promise<BudgetOverview> => {
    await requireWorkspacePermission(ledger, memberId, 'budgets.manage')
    const change = budgetChangeFrom(budget)
    const overview = await overviewOf(ledger, now)
    const current =
      change.memberId === null
        ? overview.workspace
        : overview.members.find((member) => member.memberId === change.memberId)
    if (!current) throw new BudgetMemberNotFound()
    if (current.limitMicros === change.limitMicros) return overview
    await ledger.setBudget(change, memberId)
    await ledger.clearAlerts(change.memberId, monthOf(now))
    await recordReachedAlerts(ledger, now)
    return overviewOf(ledger, now)
  })

export const readOwnBudget = ({ transactor }: Dependencies, { memberId, now }: { memberId: MemberId; now: Date }) =>
  transactor.run(async (ledger) => {
    const [own] = await ledger.memberSpends(monthStartOf(now), memberId)
    return budgetProgressOf(own?.limitMicros ?? null, own?.spentMicros ?? 0)
  })

export const findUsedUpBudget = ({ transactor }: Dependencies, { memberId, now }: { memberId: MemberId; now: Date }) =>
  transactor.run(async (ledger) => usedUpBudgetOf(await ledger.uses(monthStartOf(now), memberId)))

export const recordBudgetAlerts = ({ transactor }: Dependencies, { now }: { now: Date }) =>
  transactor.run((ledger) => recordReachedAlerts(ledger, now))

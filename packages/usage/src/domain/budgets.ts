import type { MemberId } from '@spyria/kernel'
import { BudgetMemberNotFound, InvalidBudget } from './errors.ts'

export const budgetThresholds = [80, 100] as const
export type BudgetThreshold = (typeof budgetThresholds)[number]
export type BudgetScope = 'member' | 'workspace'
export type BudgetUse = { memberId: MemberId | null; limitMicros: number; spentMicros: number }
export type BudgetAlert = { memberId: MemberId | null; threshold: BudgetThreshold }
export type MemberSpend = { memberId: MemberId; name: string; limitMicros: number | null; spentMicros: number }
export type BudgetProgress = { limitMicros: number | null; spentMicros: number; percent: number | null }
export type MemberBudget = BudgetProgress & { memberId: MemberId; name: string }
export type BudgetOverview = { workspace: BudgetProgress; members: readonly MemberBudget[] }
export type BudgetChange = { memberId: MemberId | null; limitMicros: number | null }

const microsPerDollar = 1_000_000
const maxBudgetMicros = 1_000_000 * microsPerDollar

export const monthStartOf = (now: Date) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
export const monthOf = (now: Date) => monthStartOf(now).toISOString().slice(0, 7)

export const budgetLabelOf = (limitMicros: number | null) =>
  limitMicros === null ? 'None' : `$${(limitMicros / microsPerDollar).toFixed(2)}`

export const budgetProgressOf = (limitMicros: number | null, spentMicros: number): BudgetProgress => ({
  limitMicros,
  spentMicros,
  percent: limitMicros === null ? null : Math.floor((spentMicros * 100) / limitMicros),
})

export const reachedThresholdsOf = ({ limitMicros, spentMicros }: BudgetUse) =>
  budgetThresholds.filter((threshold) => spentMicros * 100 >= limitMicros * threshold)

export const budgetAlertsOf = (uses: readonly BudgetUse[]): BudgetAlert[] =>
  uses.flatMap((use) => reachedThresholdsOf(use).map((threshold) => ({ memberId: use.memberId, threshold })))

export const budgetAlertIdOf = (month: string, { memberId, threshold }: BudgetAlert) =>
  `${month}/${threshold}/${memberId ?? 'workspace'}`

export const usedUpBudgetOf = (uses: readonly BudgetUse[]): BudgetScope | null => {
  const usedUp = uses.filter((use) => use.spentMicros >= use.limitMicros)
  if (usedUp.some((use) => use.memberId === null)) return 'workspace'
  return usedUp.length > 0 ? 'member' : null
}

export const budgetChangeFrom = (body: unknown): BudgetChange => {
  if (typeof body !== 'object' || body === null || !('dollars' in body)) throw new InvalidBudget()
  const { memberId = null, dollars } = body as { memberId?: unknown; dollars: unknown }
  if (memberId !== null && (typeof memberId !== 'string' || memberId === '')) throw new BudgetMemberNotFound()
  if (dollars === null) return { memberId: memberId as MemberId | null, limitMicros: null }
  const limitMicros = typeof dollars === 'number' ? Math.round(dollars * microsPerDollar) : Number.NaN
  if (!(limitMicros > 0 && limitMicros <= maxBudgetMicros)) throw new InvalidBudget()
  return { memberId: memberId as MemberId | null, limitMicros }
}

export const budgetOverviewOf = (
  members: readonly MemberSpend[],
  workspace: { limitMicros: number | null; spentMicros: number },
): BudgetOverview => ({
  workspace: budgetProgressOf(workspace.limitMicros, workspace.spentMicros),
  members: members.map(({ memberId, name, limitMicros, spentMicros }) => ({
    memberId,
    name,
    ...budgetProgressOf(limitMicros, spentMicros),
  })),
})

export const isOverAlertLine = ({ percent }: BudgetProgress) => percent !== null && percent >= budgetThresholds[0]

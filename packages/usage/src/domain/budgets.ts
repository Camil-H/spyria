import type { MemberId } from '@spyria/kernel'
import { BudgetRoleNotFound, InvalidBudget } from './errors.ts'

export const budgetPeriods = ['day', 'week', 'month'] as const
export type BudgetPeriod = (typeof budgetPeriods)[number]
export type BudgetLimits = Readonly<Record<BudgetPeriod, number | null>>
export const budgetThresholds = [80, 100] as const
export type BudgetThreshold = (typeof budgetThresholds)[number]
export type MemberPeriodSpend = {
  memberId: MemberId
  name: string
  period: BudgetPeriod
  limitMicros: number | null
  spentMicros: number
}
export type BudgetProgress = { limitMicros: number | null; spentMicros: number; percent: number | null }
export type PeriodBudget = BudgetProgress & { period: BudgetPeriod }
export type MemberBudget = PeriodBudget & { memberId: MemberId; name: string }
export type RoleBudget = { roleId: string; name: string; memberCount: number; limits: BudgetLimits }
export type BudgetOverview = { roles: readonly RoleBudget[]; overAlertLine: readonly MemberBudget[] }
export type RoleBudgetChange = { roleId: string; limits: BudgetLimits }
export type BudgetAlert = { memberId: MemberId; period: BudgetPeriod; startsOn: string; threshold: BudgetThreshold }

const microsPerDollar = 1_000_000
const maxBudgetMicros = 1_000_000 * microsPerDollar
const dayMilliseconds = 24 * 3_600_000
const periodAdjectives: Readonly<Record<BudgetPeriod, string>> = { day: 'daily', week: 'weekly', month: 'monthly' }
const longestPeriodsFirst = budgetPeriods.toReversed()

export const periodAdjectiveOf = (period: BudgetPeriod) => periodAdjectives[period]
export const periodTitleOf = (period: BudgetPeriod) =>
  `${periodAdjectives[period].charAt(0).toUpperCase()}${periodAdjectives[period].slice(1)}`

export const periodStartOf = (period: BudgetPeriod, now: Date) => {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  if (period === 'day') return new Date(today)
  if (period === 'month') return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
  const daysSinceMonday = (now.getUTCDay() + 6) % 7
  return new Date(today - daysSinceMonday * dayMilliseconds)
}

export const periodStartsOf = (now: Date) =>
  Object.fromEntries(budgetPeriods.map((period) => [period, periodStartOf(period, now)])) as Readonly<
    Record<BudgetPeriod, Date>
  >

export const startsOnOf = (period: BudgetPeriod, now: Date) => periodStartOf(period, now).toISOString().slice(0, 10)

export const isInCurrentPeriod = (alert: { period: BudgetPeriod; startsOn: string }, now: Date) =>
  alert.startsOn === startsOnOf(alert.period, now)

export const budgetLabelOf = (limitMicros: number | null) =>
  limitMicros === null ? 'None' : `$${(limitMicros / microsPerDollar).toFixed(2)}`

export const budgetProgressOf = (limitMicros: number | null, spentMicros: number): BudgetProgress => ({
  limitMicros,
  spentMicros,
  percent: limitMicros === null ? null : Math.floor((spentMicros * 100) / limitMicros),
})

export const reachedThresholdsOf = ({ limitMicros, spentMicros }: { limitMicros: number; spentMicros: number }) =>
  budgetThresholds.filter((threshold) => spentMicros * 100 >= limitMicros * threshold)

const limitedSpendsOf = (spends: readonly MemberPeriodSpend[]) =>
  spends.filter((spend): spend is MemberPeriodSpend & { limitMicros: number } => spend.limitMicros !== null)

export const budgetAlertsOf = (spends: readonly MemberPeriodSpend[], now: Date): BudgetAlert[] =>
  limitedSpendsOf(spends).flatMap((spend) =>
    reachedThresholdsOf(spend).map((threshold) => ({
      memberId: spend.memberId,
      period: spend.period,
      startsOn: startsOnOf(spend.period, now),
      threshold,
    })),
  )

export const budgetAlertIdOf = ({ memberId, period, startsOn, threshold }: BudgetAlert) =>
  `${period}/${startsOn}/${threshold}/${memberId}`

export const usedUpPeriodOf = (spends: readonly MemberPeriodSpend[]): BudgetPeriod | null =>
  longestPeriodsFirst.find((period) =>
    limitedSpendsOf(spends).some((spend) => spend.period === period && spend.spentMicros >= spend.limitMicros),
  ) ?? null

const limitMicrosFrom = (dollars: unknown) => {
  if (dollars === null) return null
  const limitMicros = typeof dollars === 'number' ? Math.round(dollars * microsPerDollar) : Number.NaN
  if (!(limitMicros > 0 && limitMicros <= maxBudgetMicros)) throw new InvalidBudget()
  return limitMicros
}

export const roleBudgetChangeFrom = (body: unknown): RoleBudgetChange => {
  if (typeof body !== 'object' || body === null) throw new InvalidBudget()
  const { roleId, dollars } = body as { roleId?: unknown; dollars?: unknown }
  if (typeof roleId !== 'string' || roleId === '') throw new BudgetRoleNotFound()
  if (typeof dollars !== 'object' || dollars === null) throw new InvalidBudget()
  const dollarsByPeriod = dollars as Readonly<Record<string, unknown>>
  if (!budgetPeriods.every((period) => period in dollarsByPeriod)) throw new InvalidBudget()
  return {
    roleId,
    limits: Object.fromEntries(
      budgetPeriods.map((period) => [period, limitMicrosFrom(dollarsByPeriod[period])]),
    ) as BudgetLimits,
  }
}

export const changedPeriodsOf = (current: BudgetLimits, next: BudgetLimits) =>
  budgetPeriods.filter((period) => current[period] !== next[period])

export const roleTotalOf = (limitMicros: number | null, memberCount: number) =>
  limitMicros === null ? null : limitMicros * memberCount

export const workspaceTotalsOf = (roles: readonly RoleBudget[]) =>
  Object.fromEntries(
    budgetPeriods.map((period) => [
      period,
      roles.some((role) => role.memberCount > 0 && role.limits[period] === null)
        ? null
        : roles.reduce((total, role) => total + (roleTotalOf(role.limits[period], role.memberCount) ?? 0), 0),
    ]),
  ) as BudgetLimits

export const isOverAlertLine = ({ percent }: BudgetProgress) => percent !== null && percent >= budgetThresholds[0]

export const budgetOverviewOf = (
  roles: readonly RoleBudget[],
  spends: readonly MemberPeriodSpend[],
): BudgetOverview => ({
  roles,
  overAlertLine: limitedSpendsOf(spends)
    .map(({ memberId, name, period, limitMicros, spentMicros }) => ({
      memberId,
      name,
      period,
      ...budgetProgressOf(limitMicros, spentMicros),
    }))
    .filter(isOverAlertLine),
})

export const ownBudgetsOf = (spends: readonly MemberPeriodSpend[]): PeriodBudget[] =>
  budgetPeriods.map((period) => {
    const spend = spends.find((candidate) => candidate.period === period)
    return { period, ...budgetProgressOf(spend?.limitMicros ?? null, spend?.spentMicros ?? 0) }
  })

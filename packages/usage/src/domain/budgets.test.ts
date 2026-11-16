import { expect, test } from 'bun:test'
import { memberId } from '@spyria/kernel'
import {
  type BudgetPeriod,
  budgetAlertIdOf,
  budgetAlertsOf,
  budgetOverviewOf,
  budgetProgressOf,
  changedPeriodsOf,
  isInCurrentPeriod,
  type MemberPeriodSpend,
  ownBudgetsOf,
  periodStartOf,
  type RoleBudget,
  reachedThresholdsOf,
  roleBudgetChangeFrom,
  roleTotalOf,
  startsOnOf,
  usedUpPeriodOf,
  workspaceTotalsOf,
} from './budgets.ts'

const bob = memberId('member-bob')
const lee = memberId('member-lee')
const spend = (
  owner: MemberPeriodSpend['memberId'],
  period: BudgetPeriod,
  limitMicros: number | null,
  spentMicros: number,
): MemberPeriodSpend => ({ memberId: owner, name: owner === bob ? 'Bob' : 'Lee', period, limitMicros, spentMicros })
const role = (name: string, memberCount: number, limits: Partial<RoleBudget['limits']>): RoleBudget => ({
  roleId: `role-${name.toLowerCase()}`,
  name,
  memberCount,
  limits: { day: null, week: null, month: null, ...limits },
})
const now = new Date('2026-11-18T15:00:00.000Z')

test.each([
  [0, []],
  [799_999, []],
  [800_000, [80]],
  [999_999, [80]],
  [1_000_000, [80, 100]],
  [2_500_000, [80, 100]],
])('$%d micros of a $1 budget reaches %p', (spentMicros, thresholds) => {
  expect(reachedThresholdsOf({ limitMicros: 1_000_000, spentMicros })).toEqual(thresholds as never)
})

test('a day starts at 00:00 UTC, a week on Monday and a month on the 1st, whatever the offset of the clock', () => {
  const startsOf = (at: string) =>
    (['day', 'week', 'month'] as const).map((period) => periodStartOf(period, new Date(at)).toISOString())
  expect(startsOf('2026-11-18T15:00:00.000Z')).toEqual([
    '2026-11-18T00:00:00.000Z',
    '2026-11-16T00:00:00.000Z',
    '2026-11-01T00:00:00.000Z',
  ])
  expect(startsOf('2026-11-16T00:00:00.000Z')[1]).toBe('2026-11-16T00:00:00.000Z')
  expect(startsOf('2026-11-22T23:59:59.999Z')[1]).toBe('2026-11-16T00:00:00.000Z')
  expect(startsOf('2026-10-31T22:30:00-04:00')).toEqual([
    '2026-11-01T00:00:00.000Z',
    '2026-10-26T00:00:00.000Z',
    '2026-11-01T00:00:00.000Z',
  ])
  expect(startsOnOf('week', new Date('2027-01-01T12:00:00.000Z'))).toBe('2026-12-28')
  expect(startsOnOf('month', new Date('2027-01-01T00:00:00.000Z'))).toBe('2027-01-01')
})

test('an alert counts only in the period it was reached in', () => {
  expect(isInCurrentPeriod({ period: 'day', startsOn: '2026-11-18' }, now)).toBe(true)
  expect(isInCurrentPeriod({ period: 'day', startsOn: '2026-11-17' }, now)).toBe(false)
  expect(isInCurrentPeriod({ period: 'week', startsOn: '2026-11-16' }, now)).toBe(true)
  expect(isInCurrentPeriod({ period: 'month', startsOn: '2026-10-01' }, now)).toBe(false)
})

test('the longest used up period refuses; spend under every limit or without a limit refuses nothing', () => {
  expect(usedUpPeriodOf([])).toBeNull()
  expect(usedUpPeriodOf([spend(bob, 'day', null, 9_000_000), spend(bob, 'month', 5_000_000, 1)])).toBeNull()
  expect(usedUpPeriodOf([spend(bob, 'day', 1_000_000, 1_000_000), spend(bob, 'month', 5_000_000, 1)])).toBe('day')
  expect(usedUpPeriodOf([spend(bob, 'day', 1_000_000, 1_200_000), spend(bob, 'week', 1_000_000, 1_200_000)])).toBe(
    'week',
  )
  expect(usedUpPeriodOf([spend(bob, 'month', 1_000_000, 1_000_000), spend(bob, 'day', 1_000_000, 2)])).toBe('month')
})

test('alerts are one per reached threshold, member and period, keyed by the start of the period so each starts afresh', () => {
  const alerts = budgetAlertsOf(
    [
      spend(bob, 'day', 1_000_000, 850_000),
      spend(bob, 'month', null, 850_000),
      spend(lee, 'day', 1_000_000, 10),
      spend(lee, 'week', 1_000_000, 1_000_000),
    ],
    now,
  )
  expect(alerts).toEqual([
    { memberId: bob, period: 'day', startsOn: '2026-11-18', threshold: 80 },
    { memberId: lee, period: 'week', startsOn: '2026-11-16', threshold: 80 },
    { memberId: lee, period: 'week', startsOn: '2026-11-16', threshold: 100 },
  ])
  expect(alerts.map(budgetAlertIdOf)).toEqual([
    'day/2026-11-18/80/member-bob',
    'week/2026-11-16/80/member-lee',
    'week/2026-11-16/100/member-lee',
  ])
})

test('a role budget change sets each period in dollars per member, or null for no limit', () => {
  expect(roleBudgetChangeFrom({ roleId: 'role-member', dollars: { day: 1.5, week: null, month: 20 } })).toEqual({
    roleId: 'role-member',
    limits: { day: 1_500_000, week: null, month: 20_000_000 },
  })
  for (const dollars of [
    null,
    {},
    { day: 1, week: 1 },
    { day: 0, week: null, month: null },
    { day: -1, week: null, month: null },
    { day: '1', week: null, month: null },
    { day: 1_000_001, week: null, month: null },
    { day: Number.NaN, week: null, month: null },
  ])
    expect(() => roleBudgetChangeFrom({ roleId: 'role-member', dollars })).toThrow(
      'A budget is an amount above $0 and up to $1,000,000',
    )
  for (const roleId of [undefined, '', 3])
    expect(() => roleBudgetChangeFrom({ roleId, dollars: { day: 1, week: 1, month: 1 } })).toThrow(
      'Budgets are set for roles of the workspace',
    )
  expect(changedPeriodsOf({ day: 1, week: null, month: 3 }, { day: 1, week: 2, month: null })).toEqual([
    'week',
    'month',
  ])
})

test('a role total is its budget per member times its members; the workspace total sums them and has no limit once a role with members has none', () => {
  expect(roleTotalOf(5_000_000, 3)).toBe(15_000_000)
  expect(roleTotalOf(5_000_000, 0)).toBe(0)
  expect(roleTotalOf(null, 3)).toBeNull()
  expect(
    workspaceTotalsOf([
      role('Admin', 1, { day: 10_000_000, month: 100_000_000 }),
      role('Member', 3, { day: 5_000_000, week: 20_000_000, month: 50_000_000 }),
      role('Guest', 0, {}),
    ]),
  ).toEqual({ day: 25_000_000, week: null, month: 250_000_000 })
  expect(workspaceTotalsOf([])).toEqual({ day: 0, week: 0, month: 0 })
})

test('the overview lists the members over 80% of a budget, and a member reads every period with or without a limit', () => {
  const spends = [
    spend(bob, 'day', 1_000_000, 799_990),
    spend(bob, 'week', 1_000_000, 900_000),
    spend(bob, 'month', null, 900_000),
  ]
  expect(budgetOverviewOf([], spends).overAlertLine).toEqual([
    { memberId: bob, name: 'Bob', period: 'week', limitMicros: 1_000_000, spentMicros: 900_000, percent: 90 },
  ])
  expect(ownBudgetsOf(spends)).toEqual([
    { period: 'day', limitMicros: 1_000_000, spentMicros: 799_990, percent: 79 },
    { period: 'week', limitMicros: 1_000_000, spentMicros: 900_000, percent: 90 },
    { period: 'month', limitMicros: null, spentMicros: 900_000, percent: null },
  ])
  expect(budgetProgressOf(null, 5)).toEqual({ limitMicros: null, spentMicros: 5, percent: null })
})

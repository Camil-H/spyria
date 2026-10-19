import { expect, test } from 'bun:test'
import { memberId } from '@spyria/kernel'
import {
  type BudgetUse,
  budgetAlertIdOf,
  budgetAlertsOf,
  budgetChangeFrom,
  budgetProgressOf,
  monthOf,
  monthStartOf,
  reachedThresholdsOf,
  usedUpBudgetOf,
} from './budgets.ts'

const bob = memberId('member-bob')
const lee = memberId('member-lee')
const use = (owner: BudgetUse['memberId'], limitMicros: number, spentMicros: number): BudgetUse => ({
  memberId: owner,
  limitMicros,
  spentMicros,
})

test.each([
  [0, []],
  [799_999, []],
  [800_000, [80]],
  [999_999, [80]],
  [1_000_000, [80, 100]],
  [2_500_000, [80, 100]],
])('$%d micros of a $1 budget reaches %p', (spentMicros, thresholds) => {
  expect(reachedThresholdsOf(use(bob, 1_000_000, spentMicros))).toEqual(thresholds as never)
})

test('a month starts on the 1st at 00:00 UTC, whatever the offset of the clock, and the year rolls over', () => {
  expect(monthStartOf(new Date('2026-10-31T23:59:59.999Z')).toISOString()).toBe('2026-10-01T00:00:00.000Z')
  expect(monthStartOf(new Date('2026-11-01T00:00:00.000Z')).toISOString()).toBe('2026-11-01T00:00:00.000Z')
  expect(monthStartOf(new Date('2026-10-31T22:30:00-04:00')).toISOString()).toBe('2026-11-01T00:00:00.000Z')
  expect(monthOf(new Date('2027-01-01T00:00:00.000Z'))).toBe('2027-01')
  expect(monthOf(new Date('2026-12-31T23:59:59.999Z'))).toBe('2026-12')
})

test('a used up workspace total takes precedence over a used up member budget; spend under the limit refuses nothing', () => {
  expect(usedUpBudgetOf([])).toBeNull()
  expect(usedUpBudgetOf([use(bob, 1_000_000, 999_999), use(null, 5_000_000, 1)])).toBeNull()
  expect(usedUpBudgetOf([use(bob, 1_000_000, 1_000_000)])).toBe('member')
  expect(usedUpBudgetOf([use(bob, 1_000_000, 1_200_000), use(null, 1_500_000, 1_500_000)])).toBe('workspace')
  expect(usedUpBudgetOf([use(null, 1_500_000, 1_600_000), use(bob, 9_000_000, 0)])).toBe('workspace')
})

test('alerts are one per reached threshold and scope, keyed by month so each month starts afresh', () => {
  const alerts = budgetAlertsOf([
    use(bob, 1_000_000, 850_000),
    use(lee, 1_000_000, 10),
    use(null, 1_000_000, 1_000_000),
  ])
  expect(alerts).toEqual([
    { memberId: bob, threshold: 80 },
    { memberId: null, threshold: 80 },
    { memberId: null, threshold: 100 },
  ])
  expect(alerts.map((alert) => budgetAlertIdOf('2026-10', alert))).toEqual([
    '2026-10/80/member-bob',
    '2026-10/80/workspace',
    '2026-10/100/workspace',
  ])
  expect(budgetAlertIdOf('2026-11', { memberId: bob, threshold: 80 })).toBe('2026-11/80/member-bob')
})

test('a budget change is a positive amount of dollars for a member or the workspace, or null to remove it', () => {
  expect(budgetChangeFrom({ memberId: 'member-bob', dollars: 1.5 })).toEqual({ memberId: bob, limitMicros: 1_500_000 })
  expect(budgetChangeFrom({ dollars: 2 })).toEqual({ memberId: null, limitMicros: 2_000_000 })
  expect(budgetChangeFrom({ memberId: 'member-bob', dollars: null })).toEqual({ memberId: bob, limitMicros: null })
  for (const body of [
    null,
    {},
    { dollars: 0 },
    { dollars: -1 },
    { dollars: '1' },
    { dollars: 1_000_001 },
    { dollars: Number.NaN },
  ])
    expect(() => budgetChangeFrom(body)).toThrow('A monthly budget is an amount above $0 and up to $1,000,000')
  expect(() => budgetChangeFrom({ memberId: '', dollars: 1 })).toThrow('Budgets are set for active members')
})

test('progress floors the percentage so 79.99% never reads 80%; no budget has no percentage', () => {
  expect(budgetProgressOf(1_000_000, 799_990)).toEqual({ limitMicros: 1_000_000, spentMicros: 799_990, percent: 79 })
  expect(budgetProgressOf(null, 5)).toEqual({ limitMicros: null, spentMicros: 5, percent: null })
})

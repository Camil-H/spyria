import { expect, test } from 'bun:test'
import { currentMonth, formatCost, formatMonth, formatTokens, pickableMonths } from './format.ts'

test('tokens get thousands separators', () => {
  expect([0, 999, 12400, 1234567].map(formatTokens)).toEqual(['0', '999', '12,400', '1,234,567'])
})

test('cost shows dollars with 2 decimals and < $0.01 below a cent', () => {
  expect([0, 1, 9999, 10_000, 180_000, 1_234_560_000].map(formatCost)).toEqual([
    '$0.00',
    '< $0.01',
    '< $0.01',
    '$0.01',
    '$0.18',
    '$1,234.56',
  ])
})

test('the current month is the UTC calendar month', () => {
  expect(currentMonth(new Date('2026-10-31T23:59:59Z'))).toBe('2026-10')
  expect(currentMonth(new Date('2026-11-01T00:00:00Z'))).toBe('2026-11')
})

test('months read as month and year', () => {
  expect(formatMonth('2026-01')).toBe('January 2026')
})

test('pickable months always include the current one, newest first, without duplicates', () => {
  expect(pickableMonths(['2026-08', '2026-10', '2025-12'], '2026-10')).toEqual(['2026-10', '2026-08', '2025-12'])
  expect(pickableMonths([], '2026-10')).toEqual(['2026-10'])
})

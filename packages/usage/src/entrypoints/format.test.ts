import { expect, test } from 'bun:test'
import { currentMonth, formatCost, formatMonth, formatTokens, pickableMonths } from './format.ts'

test.each([
  ['tokens 0', formatTokens(0), '0'],
  ['tokens 999', formatTokens(999), '999'],
  ['tokens 12400', formatTokens(12400), '12,400'],
  ['tokens 1234567', formatTokens(1234567), '1,234,567'],
  ['no cost', formatCost(0), '$0.00'],
  ['a cost below a cent', formatCost(1), '< $0.01'],
  ['a cost just below a cent', formatCost(9999), '< $0.01'],
  ['a cent', formatCost(10_000), '$0.01'],
  ['a cost in cents', formatCost(180_000), '$0.18'],
  ['a cost in dollars', formatCost(1_234_560_000), '$1,234.56'],
  ['the UTC month at its last second', currentMonth(new Date('2026-10-31T23:59:59Z')), '2026-10'],
  ['the UTC month at its first second', currentMonth(new Date('2026-11-01T00:00:00Z')), '2026-11'],
  ['a month', formatMonth('2026-01'), 'January 2026'],
])('%s reads %p', (_, formatted, expected) => {
  expect(formatted).toBe(expected)
})

test('pickable months always include the current one, newest first, without duplicates', () => {
  expect(pickableMonths(['2026-08', '2026-10', '2025-12'], '2026-10')).toEqual(['2026-10', '2026-08', '2025-12'])
  expect(pickableMonths([], '2026-10')).toEqual(['2026-10'])
})

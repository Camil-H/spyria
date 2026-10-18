import { expect, test } from 'bun:test'
import { currentMonth, formatBucket, formatChange, formatFactor, formatMonth, pickableMonths } from './format.ts'

test.each([
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

test.each([
  [formatChange(1), '+100%'],
  [formatChange(-0.5), '−50%'],
  [formatChange(0.0004), '0%'],
  [formatChange(null), '—'],
  [formatFactor('pricePerToken', 10), '$10.00'],
  [formatFactor('tokensPerRequest', 1000.4), '1,000'],
  [formatFactor('turnsPerSession', 4 / 3), '1.33'],
  [formatFactor('users', null), '—'],
  [formatBucket('2026-10-05', 'week'), 'Oct 5'],
  [formatBucket('2026-10-01', 'month'), 'Oct 2026'],
])('%p reads %p', (formatted, expected) => {
  expect(formatted).toBe(expected)
})

import { expect, test } from 'bun:test'
import { currentMonth, formatMonth, pickableMonths } from './format.ts'

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

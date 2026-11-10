import { expect, test } from 'bun:test'
import { formatBucket, formatChange, formatFactor } from './format.ts'

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

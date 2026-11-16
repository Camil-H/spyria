import { expect, test } from 'bun:test'
import { formatBucket, formatChange, formatDollars, formatFactor, groupedDollarsOf, typedDollarsOf } from './format.ts'

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
  [formatDollars(1500), '1,500'],
  [formatDollars(1234.5), '1,234.5'],
  [groupedDollarsOf('1500.25'), '1,500.25'],
  [groupedDollarsOf('1,500'), '1,500'],
  [groupedDollarsOf(''), ''],
  [groupedDollarsOf('ten'), 'ten'],
  [groupedDollarsOf('0.004'), '0.004'],
  [groupedDollarsOf('1,5'), '1,5'],
  [formatDollars(0.005), '0.005'],
  [typedDollarsOf(' 1,500.5 '), 1500.5],
  [typedDollarsOf('1500'), 1500],
  [typedDollarsOf('1,5'), null],
  [typedDollarsOf('15,00'), null],
  [typedDollarsOf('0x10'), null],
  [typedDollarsOf('1e3'), null],
  [typedDollarsOf('-5'), null],
])('%p reads %p', (formatted, expected) => {
  expect(formatted).toBe(expected)
})

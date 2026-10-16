import { expect, test } from 'bun:test'
import { formatCost, formatTokens } from './format.ts'

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
])('%s reads %p', (_, formatted, expected) => {
  expect(formatted).toBe(expected)
})

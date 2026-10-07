import type { UsageMonth } from '../domain/usage.ts'

const microsPerDollar = 1_000_000
const microsPerCent = 10_000

export const formatTokens = (tokens: number) => tokens.toLocaleString('en-US')

export const formatCost = (costMicros: number) =>
  costMicros > 0 && costMicros < microsPerCent
    ? '< $0.01'
    : `$${(costMicros / microsPerDollar).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

export const currentMonth = (now = new Date()): UsageMonth => now.toISOString().slice(0, 7)

export const formatMonth = (month: UsageMonth) =>
  new Date(`${month}-01T00:00:00Z`).toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' })

export const pickableMonths = (months: readonly UsageMonth[], current: UsageMonth) =>
  [...new Set([current, ...months])].sort().reverse()

import type { UsageMonth } from '../domain/usage.ts'

export const currentMonth = (now = new Date()): UsageMonth => now.toISOString().slice(0, 7)

export const formatMonth = (month: UsageMonth) =>
  new Date(`${month}-01T00:00:00Z`).toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' })

export const pickableMonths = (months: readonly UsageMonth[], current: UsageMonth) =>
  [...new Set([current, ...months])].sort().reverse()

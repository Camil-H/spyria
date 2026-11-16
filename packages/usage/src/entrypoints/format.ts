import type { SpendFactorName, SpendGranularity } from '../domain/spend.ts'

const formatNumber = (value: number, maximumFractionDigits: number) =>
  value.toLocaleString('en-US', { maximumFractionDigits })

export const formatFactor = (name: SpendFactorName, value: number | null) => {
  if (value === null) return '—'
  if (name === 'pricePerToken')
    return `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
  return formatNumber(value, name === 'tokensPerRequest' ? 0 : 2)
}

export const formatChange = (change: number | null) => {
  if (change === null) return '—'
  const percent = Math.round(change * 100)
  return `${percent > 0 ? '+' : percent < 0 ? '−' : ''}${Math.abs(percent)}%`
}

export const formatBucket = (bucket: string, granularity: SpendGranularity) =>
  new Date(`${bucket}T00:00:00Z`).toLocaleDateString('en-US', {
    timeZone: 'UTC',
    ...(granularity === 'month' ? { month: 'short', year: 'numeric' } : { month: 'short', day: 'numeric' }),
  })

export const formatDollars = (dollars: number) => formatNumber(dollars, 6)

const typedDollarsPattern = /^(\d{1,3}(,\d{3})+|\d+)(\.\d+)?$/

export const typedDollarsOf = (typed: string) => {
  const trimmed = typed.trim()
  return typedDollarsPattern.test(trimmed) ? Number(trimmed.replaceAll(',', '')) : null
}

export const groupedDollarsOf = (typed: string) => {
  const dollars = typedDollarsOf(typed)
  return dollars === null ? typed : formatDollars(dollars)
}

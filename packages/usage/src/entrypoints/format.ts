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

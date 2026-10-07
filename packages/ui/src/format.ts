const microsPerDollar = 1_000_000
const microsPerCent = 10_000

export const formatTokens = (tokens: number) => tokens.toLocaleString('en-US')

export const formatCost = (costMicros: number) =>
  costMicros > 0 && costMicros < microsPerCent
    ? '< $0.01'
    : `$${(costMicros / microsPerDollar).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

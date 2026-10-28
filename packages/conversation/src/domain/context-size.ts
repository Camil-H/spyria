export type ContextSize = Readonly<{ tokens: number; window: number | null }>

const nearlyFullPercent = 80
const tokensOf = (count: number) => count.toLocaleString('en-US')
const compactTokens = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 })

export const contextFullnessOf = ({ tokens, window }: ContextSize) => {
  if (!window)
    return {
      percent: null,
      isNearlyFull: false,
      shown: compactTokens.format(tokens),
      label: `Context: ${tokensOf(tokens)} tokens`,
    }
  const percent = Math.min(100, Math.round((tokens / window) * 100))
  return {
    percent,
    isNearlyFull: percent >= nearlyFullPercent,
    shown: `${percent}%`,
    label: `Context: ${percent}% full, ${tokensOf(tokens)} of ${tokensOf(window)} tokens`,
  }
}

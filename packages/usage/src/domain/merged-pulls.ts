import { csvFieldOf } from './csv.ts'
import type { MergedPull } from './spend.ts'

export type CostBin = { fromMicros: number; toMicros: number; pulls: number }

const niceStepOf = (roughStep: number) => {
  const magnitude = 10 ** Math.floor(Math.log10(roughStep))
  const nice = [1, 2, 5, 10].find((factor) => factor * magnitude >= roughStep) ?? 10
  return nice * magnitude
}

export const costHistogramOf = (costsMicros: readonly number[], maximumBins = 10): CostBin[] => {
  if (costsMicros.length === 0) return []
  const largest = Math.max(...costsMicros)
  const step = Math.max(1, niceStepOf(Math.max(largest, 1) / maximumBins))
  const binCount = Math.max(1, Math.ceil(largest / step))
  return Array.from({ length: binCount }, (_, index) => ({
    fromMicros: index * step,
    toMicros: (index + 1) * step,
    pulls: costsMicros.filter((cost) => Math.min(Math.floor(cost / step), binCount - 1) === index).length,
  }))
}

const mergedPullsCsvHeader = ['Merged at', 'Chat', 'Repository', 'Pull request', 'Title', 'URL', 'Chat cost (USD)']

export const mergedPullsCsvOf = (pulls: readonly MergedPull[]) =>
  [
    mergedPullsCsvHeader,
    ...pulls.map((pull) => [
      pull.mergedAt,
      pull.chatName,
      pull.repository,
      pull.number,
      pull.title,
      pull.url,
      (pull.costMicros / 1_000_000).toFixed(6),
    ]),
  ]
    .map((fields) => `${fields.map((field) => csvFieldOf(String(field))).join(',')}\n`)
    .join('')

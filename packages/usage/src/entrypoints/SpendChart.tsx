import { formatCost } from '@spyria/ui'
import type { SpendChart as SpendChartData, SpendGranularity } from '../domain/spend.ts'
import { formatBucket } from './format.ts'
import { useChartWidth } from './useChartWidth.ts'

const seriesColors = [
  'var(--color-chart-1)',
  'var(--color-chart-2)',
  'var(--color-chart-3)',
  'var(--color-chart-4)',
  'var(--color-chart-5)',
  'var(--color-chart-6)',
]
const otherColor = 'var(--color-chart-other)'
const height = 200
const axisWidth = 56
const labelHeight = 20
const gridSteps = [0, 0.5, 1]

const colorOf = (key: string, index: number) => (key === 'other' ? otherColor : seriesColors[index])

export const SpendChart = ({
  chart,
  granularity,
  label,
}: {
  chart: SpendChartData
  granularity: SpendGranularity
  label: string
}) => {
  const { ref, width } = useChartWidth<HTMLElement>()
  const bucketTotals = chart.buckets.map((_, bucketIndex) =>
    chart.series.reduce((sum, series) => sum + (series.costs[bucketIndex] ?? 0), 0),
  )
  const largestTotal = Math.max(...bucketTotals, 1)
  const plotHeight = height - labelHeight
  const slotWidth = (width - axisWidth) / Math.max(chart.buckets.length, 1)
  const barWidth = Math.max(Math.min(slotWidth * 0.7, 32), 2)
  const labelledBuckets = new Set([0, Math.floor((chart.buckets.length - 1) / 2), chart.buckets.length - 1])
  return (
    <figure ref={ref} className="flex flex-col gap-2">
      <svg viewBox={`0 0 ${width} ${height}`} className="w-full" role="img" aria-label={label}>
        {gridSteps.map((step) => (
          <g key={step}>
            <line
              x1={axisWidth}
              x2={width}
              y1={plotHeight - step * plotHeight + (step === 1 ? 1 : 0)}
              y2={plotHeight - step * plotHeight + (step === 1 ? 1 : 0)}
              className="stroke-line"
            />
            <text
              x={axisWidth - 6}
              y={plotHeight - step * plotHeight + (step === 1 ? 10 : 0)}
              textAnchor="end"
              className="fill-muted text-chart-label"
            >
              {formatCost(largestTotal * step)}
            </text>
          </g>
        ))}
        {chart.buckets.map((bucket, bucketIndex) => {
          const x = axisWidth + bucketIndex * slotWidth + (slotWidth - barWidth) / 2
          const heights = chart.series.map((series) => ((series.costs[bucketIndex] ?? 0) / largestTotal) * plotHeight)
          return (
            <g key={bucket}>
              {chart.series.map((series, seriesIndex) => {
                const cost = series.costs[bucketIndex] ?? 0
                const segmentHeight = heights[seriesIndex] ?? 0
                const top = plotHeight - heights.slice(0, seriesIndex + 1).reduce((sum, value) => sum + value, 0)
                return (
                  cost > 0 && (
                    <rect
                      key={series.key}
                      x={x}
                      y={top}
                      width={barWidth}
                      height={segmentHeight}
                      style={{ fill: colorOf(series.key, seriesIndex), stroke: 'var(--color-app)' }}
                      strokeWidth={1}
                    >
                      <title>{`${series.name} · ${formatBucket(bucket, granularity)} · ${formatCost(cost)}`}</title>
                    </rect>
                  )
                )
              })}
              {labelledBuckets.has(bucketIndex) && (
                <text
                  x={bucketIndex === 0 ? x : bucketIndex === chart.buckets.length - 1 ? x + barWidth : x + barWidth / 2}
                  y={height - 4}
                  textAnchor={bucketIndex === 0 ? 'start' : bucketIndex === chart.buckets.length - 1 ? 'end' : 'middle'}
                  className="fill-muted text-chart-label"
                >
                  {formatBucket(bucket, granularity)}
                </text>
              )}
            </g>
          )
        })}
      </svg>
      <ul aria-label="Legend" className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
        {chart.series.map((series, seriesIndex) => (
          <li key={series.key} className="flex items-center gap-1.5">
            <span
              aria-hidden
              className="size-2.5 rounded-sm"
              style={{ background: colorOf(series.key, seriesIndex) }}
            />
            {series.name}
            <span className="text-muted">{formatCost(series.costs.reduce((sum, cost) => sum + cost, 0))}</span>
          </li>
        ))}
      </ul>
    </figure>
  )
}

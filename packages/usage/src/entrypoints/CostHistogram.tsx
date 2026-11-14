import { formatCost } from '@spyria/ui'
import type { CostBin } from '../domain/merged-pulls.ts'
import { useChartWidth } from './useChartWidth.ts'

const barColor = 'var(--color-chart-1)'
const height = 160
const axisWidth = 40
const rightPadding = 12
const topPadding = 8
const labelHeight = 20
const barGap = 2
const plotHeight = height - labelHeight - topPadding

const binLabelOf = ({ fromMicros, toMicros }: CostBin) => `${formatCost(fromMicros)} to ${formatCost(toMicros)}`
const pullCountOf = (pulls: number) => `${pulls} merged ${pulls === 1 ? 'PR' : 'PRs'}`

export const CostHistogram = ({ bins, label }: { bins: readonly CostBin[]; label: string }) => {
  const { ref, width } = useChartWidth<HTMLElement>()
  const largest = Math.max(...bins.map((bin) => bin.pulls), 1)
  const slotWidth = (width - axisWidth - rightPadding) / Math.max(bins.length, 1)
  const yOf = (pulls: number) => topPadding + plotHeight - (pulls / largest) * plotHeight
  const edgeLabels = new Set([0, Math.floor(bins.length / 2), bins.length])
  const edgeOf = (index: number) => (index < bins.length ? bins[index]?.fromMicros : bins.at(-1)?.toMicros) ?? 0
  return (
    <figure ref={ref}>
      <svg viewBox={`0 0 ${width} ${height}`} className="w-full" role="img" aria-label={label}>
        {[0, largest].map((pulls) => (
          <g key={pulls}>
            <line x1={axisWidth} x2={width - rightPadding} y1={yOf(pulls)} y2={yOf(pulls)} className="stroke-line" />
            <text x={axisWidth - 6} y={yOf(pulls) + 4} textAnchor="end" className="fill-muted text-chart-label">
              {pulls}
            </text>
          </g>
        ))}
        {bins.map((bin, index) => (
          <rect
            key={bin.fromMicros}
            x={axisWidth + index * slotWidth + barGap / 2}
            y={yOf(bin.pulls)}
            width={Math.max(slotWidth - barGap, 1)}
            height={plotHeight - (yOf(bin.pulls) - topPadding)}
            rx={Math.min(4, slotWidth / 4)}
            fill={barColor}
          >
            <title>{`${binLabelOf(bin)} · ${pullCountOf(bin.pulls)}`}</title>
          </rect>
        ))}
        {[...edgeLabels].map((index) => (
          <text
            key={index}
            x={axisWidth + index * slotWidth}
            y={height - 4}
            textAnchor={index === 0 ? 'start' : index === bins.length ? 'end' : 'middle'}
            className="fill-muted text-chart-label"
          >
            {formatCost(edgeOf(index))}
          </text>
        ))}
      </svg>
      <table className="sr-only">
        <caption>{label}</caption>
        <tbody>
          {bins.map((bin) => (
            <tr key={bin.fromMicros}>
              <th scope="row">{binLabelOf(bin)}</th>
              <td>{pullCountOf(bin.pulls)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  )
}

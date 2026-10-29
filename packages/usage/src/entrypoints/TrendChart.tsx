import { type PointerEvent, useState } from 'react'
import type { SpendGranularity } from '../domain/spend.ts'
import { formatBucket } from './format.ts'

type TrendPoint = { bucket: string; value: number | null }

const lineColor = 'light-dark(#2a78d6, #3987e5)'
const width = 640
const height = 160
const axisWidth = 64
const rightPadding = 12
const topPadding = 16
const labelHeight = 20
const gridSteps = [0, 0.5, 1]
const plotWidth = width - axisWidth - rightPadding
const plotHeight = height - labelHeight - topPadding

const segmentsOf = (points: readonly { x: number; y: number | null }[]) => {
  const segments: string[] = []
  let current = ''
  for (const { x, y } of points) {
    if (y === null) {
      if (current) segments.push(current)
      current = ''
    } else current += `${current ? 'L' : 'M'}${x},${y}`
  }
  return current ? [...segments, current] : segments
}

export const TrendChart = ({
  points,
  granularity,
  formatValue,
  label,
}: {
  points: readonly TrendPoint[]
  granularity: SpendGranularity
  formatValue: (value: number | null) => string
  label: string
}) => {
  const [hovered, setHovered] = useState<number | null>(null)
  const largest = Math.max(...points.map((point) => point.value ?? 0), 0) || 1
  const xOf = (index: number) =>
    axisWidth + (points.length <= 1 ? plotWidth / 2 : (index * plotWidth) / (points.length - 1))
  const yOf = (value: number) => topPadding + plotHeight - (value / largest) * plotHeight
  const positioned = points.map((point, index) => ({
    x: xOf(index),
    y: point.value === null ? null : yOf(point.value),
  }))
  const lastIndex = points.findLastIndex((point) => point.value !== null)
  const labelledBuckets = new Set([0, Math.floor((points.length - 1) / 2), points.length - 1])
  const hoveredPoint = hovered === null ? undefined : points[hovered]
  const pointAt = (event: PointerEvent<SVGRectElement>) => {
    const bounds = event.currentTarget.ownerSVGElement?.getBoundingClientRect()
    if (!bounds || points.length === 0) return
    const x = ((event.clientX - bounds.left) * width) / bounds.width
    const step = points.length <= 1 ? plotWidth : plotWidth / (points.length - 1)
    setHovered(Math.min(points.length - 1, Math.max(0, Math.round((x - axisWidth) / step))))
  }
  return (
    <figure className="relative">
      <svg viewBox={`0 0 ${width} ${height}`} className="w-full" role="img" aria-label={label}>
        {gridSteps.map((step) => (
          <g key={step}>
            <line
              x1={axisWidth}
              x2={width - rightPadding}
              y1={yOf(largest * step)}
              y2={yOf(largest * step)}
              className="stroke-line"
            />
            <text x={axisWidth - 6} y={yOf(largest * step) + 4} textAnchor="end" className="fill-muted text-[11px]">
              {formatValue(largest * step)}
            </text>
          </g>
        ))}
        {points.map(
          (point, index) =>
            labelledBuckets.has(index) && (
              <text
                key={point.bucket}
                x={xOf(index)}
                y={height - 4}
                textAnchor={index === 0 ? 'start' : index === points.length - 1 ? 'end' : 'middle'}
                className="fill-muted text-[11px]"
              >
                {formatBucket(point.bucket, granularity)}
              </text>
            ),
        )}
        {segmentsOf(positioned).map((segment) => (
          <path
            key={segment}
            d={segment}
            fill="none"
            stroke={lineColor}
            strokeWidth={2}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        ))}
        {lastIndex >= 0 && hovered === null && (
          <g>
            <circle
              cx={xOf(lastIndex)}
              cy={positioned[lastIndex]?.y ?? 0}
              r={4}
              fill={lineColor}
              stroke="var(--color-app)"
              strokeWidth={2}
            />
            <text
              x={xOf(lastIndex)}
              y={(positioned[lastIndex]?.y ?? 0) - 8}
              textAnchor="end"
              className="fill-ink text-[11px]"
            >
              {formatValue(points[lastIndex]?.value ?? null)}
            </text>
          </g>
        )}
        {hovered !== null && (
          <g>
            <line
              x1={xOf(hovered)}
              x2={xOf(hovered)}
              y1={topPadding}
              y2={topPadding + plotHeight}
              className="stroke-muted"
            />
            {positioned[hovered]?.y != null && (
              <circle
                cx={xOf(hovered)}
                cy={positioned[hovered]?.y ?? 0}
                r={4}
                fill={lineColor}
                stroke="var(--color-app)"
                strokeWidth={2}
              />
            )}
          </g>
        )}
        <rect
          x={axisWidth}
          y={0}
          width={plotWidth}
          height={height}
          fill="transparent"
          onPointerMove={pointAt}
          onPointerLeave={() => setHovered(null)}
        />
      </svg>
      {hovered !== null && hoveredPoint && (
        <div
          role="status"
          className="pointer-events-none absolute top-0 -translate-x-1/2 rounded-md border border-line bg-app px-2 py-1 text-xs whitespace-nowrap text-ink shadow-sm"
          style={{ left: `${Math.min(85, Math.max(15, (xOf(hovered) / width) * 100))}%` }}
        >
          <span className="text-muted">{formatBucket(hoveredPoint.bucket, granularity)}</span>{' '}
          {formatValue(hoveredPoint.value)}
        </div>
      )}
      <table className="sr-only">
        <caption>{label}</caption>
        <tbody>
          {points.map((point) => (
            <tr key={point.bucket}>
              <th scope="row">{formatBucket(point.bucket, granularity)}</th>
              <td>{formatValue(point.value)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  )
}

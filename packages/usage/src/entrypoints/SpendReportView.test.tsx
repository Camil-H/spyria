import { expect, test } from 'bun:test'
import { workspaceId } from '@spyria/kernel'
import { prerender } from 'react-dom/static'
import { type SpendCounts, type SpendDecomposition, spendFactorNames } from '../domain/spend.ts'
import { Decomposition } from './SpendReportView.tsx'
import { TrendChart } from './TrendChart.tsx'

const counts: SpendCounts = { costMicros: 20_000, requests: 2, tokens: 2_000, users: 1, sessions: 1, turns: 1 }
const decomposition: SpendDecomposition = {
  factors: spendFactorNames.map((name) => ({ name, current: 1, previous: 1, change: 0 })),
  biggestMover: null,
  current: counts,
  previous: counts,
}
const htmlOf = async (node: React.ReactNode) => {
  const { prelude } = await prerender(node)
  return (await new Response(prelude).text()).replaceAll('<!-- -->', '')
}
const rowsOf = (html: string) =>
  html
    .split(/<tr[^>]*>/)
    .slice(1)
    .map((row) => row.replace(/<[^>]+>/g, '|').replace(/\|+/g, '|'))
const decompositionHtmlOf = (isPersonal: boolean, previous = counts) =>
  htmlOf(
    <Decomposition
      decomposition={{ ...decomposition, previous }}
      isPersonal={isPersonal}
      granularity="day"
      workspaceId={workspaceId('workspace-acme')}
      trendKey="{}"
      readTrend={() => Promise.resolve([])}
    />,
  )

test('the workspace decomposition reads as a product: × before every factor but the first, = before the total', async () => {
  const rows = rowsOf(await decompositionHtmlOf(false))
  expect(rows.slice(1).map((row) => row.split('|').slice(1, 3).join(' '))).toEqual([
    'Users 1',
    '× Sessions per user',
    '× Turns per session',
    '× Requests per turn',
    '× Tokens per request',
    '× Price per 1M tokens',
    '= Total spend',
  ])
  expect(await decompositionHtmlOf(false)).not.toContain('Spend =')
})

test('the personal decomposition drops the Users factor and starts at Sessions without ×', async () => {
  const html = await decompositionHtmlOf(true)
  const rows = rowsOf(html)
  expect(html).not.toMatch(/users/i)
  expect(rows[1]?.split('|').slice(1, 3).join(' ')).toBe('Sessions 1')
  expect(rows.filter((row) => row.startsWith('|×|'))).toHaveLength(4)
})

test('every factor and the total spend is a closed toggle, and the total row is bold against the previous period', async () => {
  const html = await decompositionHtmlOf(false, { ...counts, costMicros: 10_000 })
  expect(html.match(/<button[^>]*aria-expanded="false"/g)).toHaveLength(7)
  const lastRow = html.slice(html.lastIndexOf('<tr'))
  expect(lastRow).toContain('font-semibold')
  expect(rowsOf(lastRow)[0]).toBe('|=|Total spend|$0.02|$0.01|+100%|')
})

test('the trend chart draws a gap where a bucket has no value, ends on a labelled dot, and lists every bucket', async () => {
  const html = await htmlOf(
    <TrendChart
      points={[
        { bucket: '2026-10-01', value: 2 },
        { bucket: '2026-10-02', value: null },
        { bucket: '2026-10-03', value: 3 },
        { bucket: '2026-10-04', value: 4 },
      ]}
      granularity="day"
      formatValue={(value) => (value === null ? '—' : `${value} turns`)}
      label="Turns per session over time"
    />,
  )
  expect(html).toContain('aria-label="Turns per session over time"')
  expect(html.match(/<path /g)).toHaveLength(2)
  expect(html.match(/<circle /g)).toHaveLength(1)
  expect(rowsOf(html)).toEqual(['|Oct 1|2 turns|', '|Oct 2|—|', '|Oct 3|3 turns|', '|Oct 4|4 turns|'])
})

import { expect, test } from 'bun:test'
import { prerender } from 'react-dom/static'
import { type SpendCounts, type SpendDecomposition, spendFactorNames, spendTrendOf } from '../domain/spend.ts'
import { Decomposition, SpendTrend } from './SpendReportView.tsx'

const counts: SpendCounts = { costMicros: 20_000, requests: 2, tokens: 2_000, users: 1, sessions: 1, turns: 1 }
const decomposition: SpendDecomposition = {
  factors: spendFactorNames.map((name) => ({ name, current: 1, previous: 1, change: 0 })),
  biggestMover: null,
  current: counts,
  previous: counts,
}
const textOf = async (isPersonal: boolean) => {
  const { prelude } = await prerender(<Decomposition decomposition={decomposition} isPersonal={isPersonal} />)
  return (await new Response(prelude).text()).replaceAll('<!-- -->', '').replace(/<[^>]+>/g, '|')
}

test('the workspace decomposition shows the six factors and the formula with users', async () => {
  const text = await textOf(false)
  for (const label of ['|Users|', '|Sessions per user|', '|Turns per session|', '|Price per 1M tokens|'])
    expect(text).toContain(label)
  expect(text).toContain(
    'Spend = users × sessions per user × turns per session × requests per turn × tokens per request × price per token',
  )
})

test('the personal decomposition drops the Users factor and reads Sessions, with a formula without users', async () => {
  const text = await textOf(true)
  expect(text).not.toContain('|Users|')
  expect(text).not.toContain('Sessions per user')
  expect(text).toContain('|Sessions|')
  expect(text).toContain('|Turns per session|')
  expect(text).toContain(
    'Spend = sessions × turns per session × requests per turn × tokens per request × price per token',
  )
  expect(text).not.toMatch(/users/i)
})

test('the decomposition ends with a bold total spend row against the previous period', async () => {
  const { prelude } = await prerender(
    <Decomposition
      decomposition={{ ...decomposition, previous: { ...counts, costMicros: 10_000 } }}
      isPersonal={false}
    />,
  )
  const html = (await new Response(prelude).text()).replaceAll('<!-- -->', '')
  const lastRow = html.slice(html.lastIndexOf('<tr'))
  expect(lastRow).toContain('font-semibold')
  expect(lastRow.replace(/<[^>]+>/g, '|').replace(/\|+/g, '|')).toBe('|Total spend|$0.02|$0.01|+100%|')
})

test('the trend has a row per bucket with its spend, factors and the biggest mover with its change', async () => {
  const trend = spendTrendOf(
    ['2026-10-01', '2026-10-02'],
    [
      { bucket: '2026-10-01', ...counts },
      { bucket: '2026-10-02', ...counts, tokens: 4_000, costMicros: 40_000 },
    ],
  )
  const htmlOf = async (isPersonal: boolean) => {
    const { prelude } = await prerender(<SpendTrend trend={trend} granularity="day" isPersonal={isPersonal} />)
    return (await new Response(prelude).text()).replaceAll('<!-- -->', '')
  }
  const workspace = await htmlOf(false)
  const rows = workspace.split(/<tr[^>]*>/).map((row) => row.replace(/<[^>]+>/g, '|').replace(/\|+/g, '|'))
  expect(rows[1]).toBe(
    '|Period|Spend|Users|Sessions per user|Turns per session|Requests per turn|Tokens per request|Price per 1M tokens|Biggest mover|',
  )
  expect(rows[2]).toBe('|Oct 1|$0.02|1|1|1|2|1,000|$10.00|—|')
  expect(rows[3]).toBe('|Oct 2|$0.04|1|1|1|2|2,000|$10.00|Tokens per request +100%|')
  expect(workspace.match(/<td class="[^"]*bg-selected[^"]*">([^<]*)</)?.[1]).toBe('2,000')
  expect(await htmlOf(true)).not.toContain('>Users<')
})

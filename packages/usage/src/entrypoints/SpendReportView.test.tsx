import { expect, test } from 'bun:test'
import { prerender } from 'react-dom/static'
import { type SpendCounts, type SpendDecomposition, spendFactorNames } from '../domain/spend.ts'
import { Decomposition } from './SpendReportView.tsx'

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
    '): users × sessions per user × turns per session × requests per turn × tokens per request × price per token',
  )
})

test('the personal decomposition drops the Users factor and reads Sessions, with a formula without users', async () => {
  const text = await textOf(true)
  expect(text).not.toContain('|Users|')
  expect(text).not.toContain('Sessions per user')
  expect(text).toContain('|Sessions|')
  expect(text).toContain('|Turns per session|')
  expect(text).toContain('): sessions × turns per session × requests per turn × tokens per request × price per token')
  expect(text).not.toMatch(/users/i)
})

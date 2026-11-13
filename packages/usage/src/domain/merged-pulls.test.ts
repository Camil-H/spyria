import { expect, test } from 'bun:test'
import { costHistogramOf, mergedPullsCsvOf } from './merged-pulls.ts'
import type { MergedPull } from './spend.ts'

const pull: MergedPull = {
  chatId: 'chat-invoice-bug',
  chatName: 'Invoice bug',
  repository: 'acme/app',
  number: 7,
  title: 'Fix the invoice total',
  url: 'https://github.com/acme/app/pull/7',
  mergedAt: '2026-10-02T13:00:00Z',
  costMicros: 60_000,
}

test('the cost histogram splits the costs into round-width bins from zero, the largest cost closing the last bin', () => {
  expect(costHistogramOf([10_000, 15_000, 60_000, 95_000, 100_000])).toEqual([
    { fromMicros: 0, toMicros: 10_000, pulls: 0 },
    { fromMicros: 10_000, toMicros: 20_000, pulls: 2 },
    { fromMicros: 20_000, toMicros: 30_000, pulls: 0 },
    { fromMicros: 30_000, toMicros: 40_000, pulls: 0 },
    { fromMicros: 40_000, toMicros: 50_000, pulls: 0 },
    { fromMicros: 50_000, toMicros: 60_000, pulls: 0 },
    { fromMicros: 60_000, toMicros: 70_000, pulls: 1 },
    { fromMicros: 70_000, toMicros: 80_000, pulls: 0 },
    { fromMicros: 80_000, toMicros: 90_000, pulls: 0 },
    { fromMicros: 90_000, toMicros: 100_000, pulls: 2 },
  ])
  expect(costHistogramOf([30_000, 70_000], 4)).toEqual([
    { fromMicros: 0, toMicros: 20_000, pulls: 0 },
    { fromMicros: 20_000, toMicros: 40_000, pulls: 1 },
    { fromMicros: 40_000, toMicros: 60_000, pulls: 0 },
    { fromMicros: 60_000, toMicros: 80_000, pulls: 1 },
  ])
  expect(costHistogramOf([0])).toEqual([{ fromMicros: 0, toMicros: 1, pulls: 1 }])
  expect(costHistogramOf([])).toEqual([])
})

test('the merged PRs CSV has a header and one row per PR, in dollars, with quotes, commas and formulas escaped', () => {
  expect(
    mergedPullsCsvOf([
      pull,
      { ...pull, chatName: 'Say "hi", again', title: '=HYPERLINK("x")', number: 8, costMicros: 1_234_567 },
    ]).split('\r\n'),
  ).toEqual([
    'Merged at,Chat,Repository,Pull request,Title,URL,Chat cost (USD)',
    '2026-10-02T13:00:00Z,Invoice bug,acme/app,7,Fix the invoice total,https://github.com/acme/app/pull/7,0.060000',
    `2026-10-02T13:00:00Z,"Say ""hi"", again",acme/app,8,"'=HYPERLINK(""x"")",https://github.com/acme/app/pull/7,1.234567`,
  ])
  expect(mergedPullsCsvOf([])).toBe('Merged at,Chat,Repository,Pull request,Title,URL,Chat cost (USD)')
})

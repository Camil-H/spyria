import { expect, test } from 'bun:test'
import {
  bucketStartsOf,
  decompositionOf,
  mergedPullsCostOf,
  type SpendCounts,
  type SpendDimensionRow,
  type SpendTotals,
  spendChartOf,
  spendFilterFrom,
  spendRowsOf,
} from './spend.ts'

const now = new Date('2026-10-18T15:30:00Z')
const at = (iso: string) => new Date(iso)
const rangeOf = (from: string, to: string) => ({ from: at(from), to: at(to) })
const counts = (overrides: Partial<SpendCounts> = {}): SpendCounts => ({
  users: 3,
  sessions: 3,
  turns: 4,
  requests: 8,
  tokens: 4000,
  costMicros: 40_000,
  ...overrides,
})
type Call = SpendTotals & {
  bucket: string
  prompterId: string
  prompterName: string
  chatId: string
  chatName: string
  projectId: string | null
  projectName: string | null
  model: string
}
const call = (overrides: Partial<Call>): SpendDimensionRow[] => {
  const { bucket, prompterId, prompterName, chatId, chatName, projectId, projectName, model, ...totals }: Call = {
    bucket: '2026-10-02',
    prompterId: 'member-alice',
    prompterName: 'Alice',
    chatId: 'chat-invoice-bug',
    chatName: 'Invoice bug',
    projectId: 'project-billing',
    projectName: 'Billing',
    model: 'anthropic/claude',
    costMicros: 10_000,
    tokens: 1000,
    requests: 1,
    ...overrides,
  }
  return [
    { dimension: 'member', bucket, key: prompterId, name: prompterName, ...totals },
    { dimension: 'project', bucket, key: projectId ?? 'none', name: projectName ?? 'No project', ...totals },
    { dimension: 'chat', bucket, key: chatId, name: chatName, ...totals },
    { dimension: 'model', bucket, key: model, name: model, ...totals },
  ]
}

test.each([
  ['this month', { period: 'this_month' }, ['2026-10-01', '2026-11-01'], ['2026-09-01', '2026-10-01']],
  ['last month', { period: 'last_month' }, ['2026-09-01', '2026-10-01'], ['2026-08-01', '2026-09-01']],
  [
    'the last 30 days with today',
    { period: 'last_30_days' },
    ['2026-09-19', '2026-10-19'],
    ['2026-08-20', '2026-09-19'],
  ],
  [
    'the last 90 days with today',
    { period: 'last_90_days' },
    ['2026-07-21', '2026-10-19'],
    ['2026-04-22', '2026-07-21'],
  ],
  [
    'a custom range with its last day, against the same length before',
    { period: 'custom', from: '2026-10-05', to: '2026-10-11' },
    ['2026-10-05', '2026-10-12'],
    ['2026-09-28', '2026-10-05'],
  ],
  ['no period as this month', {}, ['2026-10-01', '2026-11-01'], ['2026-09-01', '2026-10-01']],
])('%s', (_, query, [from, to], [previousFrom, previousTo]) => {
  expect(spendFilterFrom(query, now)).toEqual({
    current: rangeOf(`${from}T00:00:00Z`, `${to}T00:00:00Z`),
    previous: rangeOf(`${previousFrom}T00:00:00Z`, `${previousTo}T00:00:00Z`),
    granularity: 'day',
  })
})

test('this month in January compares with December of the year before', () => {
  expect(spendFilterFrom({ period: 'this_month', granularity: 'week' }, at('2027-01-10T00:00:00Z'))).toMatchObject({
    previous: rangeOf('2026-12-01T00:00:00Z', '2027-01-01T00:00:00Z'),
    granularity: 'week',
  })
})

test.each([
  { period: 'yesterday' },
  { granularity: 'hour' },
  { period: 'custom' },
  { period: 'custom', from: '2026-10-05', to: 'soon' },
  { period: 'custom', from: '2026-10-05', to: '2026-10-04' },
  { period: 'custom', from: '2025-01-01', to: '2026-10-04' },
])('the filter %p is refused', (query) => {
  expect(() => spendFilterFrom(query, now)).toThrow('The spend filter is not valid')
})

test('days, weeks starting on Monday and months bucket the period in UTC', () => {
  const october = rangeOf('2026-10-01T00:00:00Z', '2026-11-01T00:00:00Z')
  const days = bucketStartsOf(october, 'day')
  expect([days.length, days[0], days.at(-1)]).toEqual([31, '2026-10-01', '2026-10-31'])
  expect(bucketStartsOf(october, 'week')).toEqual([
    '2026-09-28',
    '2026-10-05',
    '2026-10-12',
    '2026-10-19',
    '2026-10-26',
  ])
  expect(bucketStartsOf(rangeOf('2026-07-21T00:00:00Z', '2026-10-19T00:00:00Z'), 'month')).toEqual([
    '2026-07-01',
    '2026-08-01',
    '2026-09-01',
    '2026-10-01',
  ])
})

test('the six factors multiply back to the spend, and doubled tokens per request is the biggest mover', () => {
  const decomposition = decompositionOf(counts({ tokens: 8000, costMicros: 80_000 }), counts())
  expect(decomposition.factors).toEqual([
    { name: 'users', current: 3, previous: 3, change: 0 },
    { name: 'sessionsPerUser', current: 1, previous: 1, change: 0 },
    { name: 'turnsPerSession', current: 4 / 3, previous: 4 / 3, change: 0 },
    { name: 'requestsPerTurn', current: 2, previous: 2, change: 0 },
    { name: 'tokensPerRequest', current: 1000, previous: 500, change: 1 },
    { name: 'pricePerToken', current: 10, previous: 10, change: 0 },
  ])
  expect(decomposition.biggestMover).toBe('tokensPerRequest')
  expect(decomposition.factors.reduce((product, factor) => product * (factor.current ?? 0), 1)).toBeCloseTo(80_000)
})

test('the biggest mover is the largest move either way: halving outweighs a rise of a half', () => {
  const decomposition = decompositionOf(counts({ users: 6, sessions: 6, turns: 3 }), counts({ users: 4, sessions: 4 }))
  expect(decomposition.factors.find((factor) => factor.name === 'users')?.change).toBe(0.5)
  expect(decomposition.factors.find((factor) => factor.name === 'turnsPerSession')?.change).toBe(-0.5)
  expect(decomposition.biggestMover).toBe('turnsPerSession')
})

test('zero denominators give no value and no change, and an empty previous period has no mover', () => {
  const empty = counts({ users: 0, sessions: 0, turns: 0, requests: 0, tokens: 0, costMicros: 0 })
  const decomposition = decompositionOf(counts({ sessions: 0, turns: 0 }), empty)
  expect(decomposition.factors.map(({ name, current, previous, change }) => [name, current, previous, change])).toEqual(
    [
      ['users', 3, 0, null],
      ['sessionsPerUser', 0, null, null],
      ['turnsPerSession', null, null, null],
      ['requestsPerTurn', null, null, null],
      ['tokensPerRequest', 500, null, null],
      ['pricePerToken', 10, null, null],
    ],
  )
  expect(decomposition.biggestMover).toBeNull()
  expect(decompositionOf(counts(), counts()).biggestMover).toBeNull()
  expect(decompositionOf(empty, counts()).factors[0]).toEqual({ name: 'users', current: 0, previous: 3, change: -1 })
})

test('rows per dimension sum their calls, carry their share and sort by cost', () => {
  const calls = [
    call({}),
    call({ bucket: '2026-10-03', costMicros: 20_000, tokens: 2000 }),
    call({
      prompterId: 'member-bob',
      prompterName: 'Bob',
      projectId: null,
      projectName: null,
      chatId: 'chat-research',
    }),
  ].flat()
  expect(spendRowsOf(calls, 'member')).toEqual([
    { key: 'member-alice', name: 'Alice', costMicros: 30_000, tokens: 3000, requests: 2, share: 0.75 },
    { key: 'member-bob', name: 'Bob', costMicros: 10_000, tokens: 1000, requests: 1, share: 0.25 },
  ])
  expect(spendRowsOf(calls, 'project').map((row) => [row.key, row.name])).toEqual([
    ['project-billing', 'Billing'],
    ['none', 'No project'],
  ])
  expect(spendRowsOf(call({ costMicros: 0 }), 'model')[0]?.share).toBe(0)
})

test('the chart fills every bucket and folds series past the fifth into Other', () => {
  const models = ['a', 'b', 'c', 'd', 'e', 'f', 'g']
  const callsOf = (shownModels: string[]) =>
    shownModels.flatMap((model, index) => call({ model, costMicros: 70_000 - index * 10_000 }))
  const calls = callsOf(models)
  const chart = spendChartOf(calls, 'model', ['2026-10-01', '2026-10-02'])
  expect(chart.series.map((series) => [series.key, series.costs])).toEqual([
    ['a', [0, 70_000]],
    ['b', [0, 60_000]],
    ['c', [0, 50_000]],
    ['d', [0, 40_000]],
    ['e', [0, 30_000]],
    ['other', [0, 30_000]],
  ])
  expect(spendChartOf(callsOf(models.slice(0, 6)), 'model', ['2026-10-02']).series.map((series) => series.key)).toEqual(
    models.slice(0, 6),
  )
})

test('cost per merged PR counts a chat once and has no value without merged PRs', () => {
  const pull = { chatId: 'chat-invoice-bug', chatName: 'Invoice bug', repository: 'acme/app', title: '', url: '' }
  expect(
    mergedPullsCostOf([
      { ...pull, number: 7, costMicros: 60_000 },
      { ...pull, number: 8, costMicros: 60_000 },
      { ...pull, chatId: 'chat-research', number: 9, costMicros: 30_000 },
    ]),
  ).toMatchObject({ costMicros: 90_000, perPullMicros: 30_000 })
  expect(mergedPullsCostOf([])).toEqual({ pulls: [], costMicros: 0, perPullMicros: null })
})

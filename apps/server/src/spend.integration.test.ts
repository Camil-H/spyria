import { beforeEach, expect, test } from 'bun:test'
import { seedSpend } from '@spyria/db/testing'
import { alice, asMember, bob, openSharedTestApp } from './testing/testing.ts'

const { database } = await openSharedTestApp()

type Row = { key: string; name: string; costMicros: number; tokens: number; requests: number; share: number }
type Report = {
  total: { costMicros: number; tokens: number; requests: number }
  tables: Record<string, Row[]>
  charts: Record<string, { buckets: string[]; series: { key: string; costs: number[] }[] }>
  decomposition: {
    factors: { name: string; current: number | null; previous: number | null; change: number | null }[]
    biggestMover: string | null
  }
  trend: (Report['decomposition'] & { bucket: string; current: { costMicros: number; requests: number } })[]
  mergedPulls: {
    pulls: { chatName: string; repository: string; number: number; costMicros: number }[]
    costMicros: number
    perPullMicros: number | null
  } | null
}

const reportOf = async (path: string, userId = alice) => {
  const response = await asMember(userId, 'GET', path)
  expect(response.status).toBe(200)
  return JSON.parse(response.body) as Report
}
const rowsOf = (rows: Row[] | undefined) =>
  (rows ?? []).map(({ name, costMicros, requests }) => [name, costMicros, requests])

beforeEach(async () => {
  await openSharedTestApp()
  await database.transaction((transaction) => seedSpend(transaction))
})

test('members are refused the workspace spend; their own usage is open to them', async () => {
  expect(await asMember(bob, 'GET', '/api/spend')).toEqual({
    status: 403,
    body: JSON.stringify({
      error: 'missing_workspace_permission',
      message: 'Your workspace role does not allow this: View costs',
    }),
  })
  expect((await asMember(bob, 'GET', '/api/spend/mine')).status).toBe(200)
  expect((await asMember(alice, 'GET', '/api/spend?period=yesterday')).status).toBe(400)
  expect((await asMember(alice, 'GET', '/api/spend?scope=chat')).status).toBe(400)
  expect((await asMember(bob, 'GET', '/api/spend/mine?scope=member&scopeKey=member-alice')).status).toBe(400)
})

test('this month totals each member, project, chat and model of the workspace only, with shares and a chart per day', async () => {
  const report = await reportOf('/api/spend?period=this_month&granularity=day')
  expect(report.total).toEqual({ costMicros: 80_000, tokens: 8000, requests: 8 })
  expect(rowsOf(report.tables.member)).toEqual([
    ['Alice', 40_000, 4],
    ['Bob', 20_000, 2],
    ['Lee', 20_000, 2],
  ])
  expect(rowsOf(report.tables.project)).toEqual([
    ['Billing', 40_000, 4],
    ['No project', 20_000, 2],
    ['Onboarding', 20_000, 2],
  ])
  expect(rowsOf(report.tables.chat)).toEqual([
    ['Invoice bug', 40_000, 4],
    ['Research', 20_000, 2],
    ['Setup helper', 20_000, 2],
  ])
  expect(rowsOf(report.tables.model)).toEqual([
    ['openai/gpt-5', 40_000, 4],
    ['anthropic/claude-sonnet', 30_000, 3],
    ['openai/gpt-5-mini', 10_000, 1],
  ])
  expect(report.tables.member?.map((row) => row.share)).toEqual([0.5, 0.25, 0.25])
  const memberChart = report.charts.member
  const secondDay = memberChart?.buckets.findIndex((bucket) => bucket.endsWith('-02')) ?? -1
  expect(
    memberChart?.series.map((series) => [series.key, series.costs[secondDay], series.costs[secondDay + 1]]),
  ).toEqual([
    ['member-alice', 20_000, 20_000],
    ['member-bob', 20_000, 0],
    ['member-lee', 0, 20_000],
  ])
  expect(report.charts.model?.series.map((series) => series.key)).toEqual([
    'openai/gpt-5',
    'anthropic/claude-sonnet',
    'openai/gpt-5-mini',
  ])
  expect((await reportOf('/api/spend?period=last_month')).total).toEqual({
    costMicros: 40_000,
    tokens: 4000,
    requests: 8,
  })
})

test('the decomposition counts delegated calls in their parent turn and finds tokens per request doubled', async () => {
  const { decomposition } = await reportOf('/api/spend')
  expect(decomposition.factors.map(({ name, current, previous, change }) => [name, current, previous, change])).toEqual(
    [
      ['users', 3, 3, 0],
      ['sessionsPerUser', 1, 1, 0],
      ['turnsPerSession', 4 / 3, 4 / 3, 0],
      ['requestsPerTurn', 2, 2, 0],
      ['tokensPerRequest', 1000, 500, 1],
      ['pricePerToken', 10, 10, 0],
    ],
  )
  expect(decomposition.biggestMover).toBe('tokensPerRequest')
})

test('cost per merged PR lists the PR merged this month with all its chat’s spend up to the period end', async () => {
  const { mergedPulls } = await reportOf('/api/spend')
  expect(mergedPulls).toMatchObject({
    costMicros: 60_000,
    perPullMicros: 60_000,
    pulls: [{ chatName: 'Invoice bug', repository: 'acme/app', number: 7, costMicros: 60_000 }],
  })
  expect((await reportOf('/api/spend?period=last_month')).mergedPulls).toEqual({
    pulls: [],
    costMicros: 0,
    perPullMicros: null,
  })
})

test('own usage holds only the requester’s calls, whatever member the request names', async () => {
  const report = await reportOf('/api/spend/mine?member=member-alice&period=this_month', bob)
  expect(report.total).toEqual({ costMicros: 20_000, tokens: 2000, requests: 2 })
  expect(Object.keys(report.tables)).toEqual(['chat', 'model'])
  expect(rowsOf(report.tables.chat)).toEqual([['Research', 20_000, 2]])
  expect(rowsOf(report.tables.model)).toEqual([['openai/gpt-5', 20_000, 2]])
  expect(report.mergedPulls).toBeNull()
  expect(report.decomposition.factors.map(({ name, current, previous }) => [name, current, previous])).toEqual([
    ['users', 1, 1],
    ['sessionsPerUser', 1, 1],
    ['turnsPerSession', 1, 1],
    ['requestsPerTurn', 2, 2],
    ['tokensPerRequest', 1000, 500],
    ['pricePerToken', 10, 10],
  ])
  expect(JSON.stringify(report)).not.toMatch(/Alice|Lee|Invoice bug|Setup helper|claude/)
})

const factorsOf = (point: Pick<Report['decomposition'], 'factors'> | undefined) =>
  Object.fromEntries((point?.factors ?? []).map(({ name, current }) => [name, current]))

test('the trend gives each day its factors and biggest mover against the day before, over the scope picked', async () => {
  const report = await reportOf(
    '/api/spend?period=this_month&granularity=day&scope=model&scopeKey=anthropic/claude-sonnet',
  )
  const secondDay = report.trend.findIndex((point) => point.bucket.endsWith('-02'))
  const [beforeUsage, dayTwo, dayThree, dayFour] = report.trend.slice(secondDay - 1, secondDay + 3)
  expect(beforeUsage?.current.requests).toBe(0)
  expect(factorsOf(dayTwo)).toEqual({
    users: 1,
    sessionsPerUser: 1,
    turnsPerSession: 1,
    requestsPerTurn: 1,
    tokensPerRequest: 1000,
    pricePerToken: 10,
  })
  expect(dayTwo?.biggestMover).toBeNull()
  expect([dayThree?.current.costMicros, factorsOf(dayThree).requestsPerTurn, dayThree?.biggestMover]).toEqual([
    20_000,
    2,
    'requestsPerTurn',
  ])
  expect([dayFour?.current.requests, dayFour?.biggestMover]).toEqual([0, null])
  expect(report.trend.reduce((sum, point) => sum + point.current.costMicros, 0)).toBe(30_000)
  expect(report.decomposition.biggestMover).toBe('tokensPerRequest')
  expect(rowsOf(report.tables.member)).toEqual([
    ['Alice', 40_000, 4],
    ['Bob', 20_000, 2],
    ['Lee', 20_000, 2],
  ])
})

test('a scope narrows the decomposition to one member, the chats without project, a model, or one of my own chats', async () => {
  const usersOf = async (path: string, userId = alice) => factorsOf((await reportOf(path, userId)).decomposition).users
  expect(await usersOf('/api/spend?scope=member&scopeKey=member-bob')).toBe(1)
  expect(await usersOf('/api/spend?scope=project&scopeKey=none')).toBe(1)
  expect(await usersOf('/api/spend?scope=model&scopeKey=openai/gpt-5')).toBe(2)
  const bobInInvoiceBug = await reportOf('/api/spend/mine?scope=chat&scopeKey=chat-invoice-bug', bob)
  expect(bobInInvoiceBug.decomposition.factors.every((factor) => !factor.current)).toBe(true)
  expect(bobInInvoiceBug.trend.every((point) => point.current.requests === 0)).toBe(true)
})

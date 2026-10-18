import { InvalidSpendFilter } from './errors.ts'

export const spendPeriods = ['this_month', 'last_month', 'last_30_days', 'last_90_days', 'custom'] as const
export const spendGranularities = ['day', 'week', 'month'] as const
export type SpendPeriod = (typeof spendPeriods)[number]
export type SpendGranularity = (typeof spendGranularities)[number]
export type SpendDimension = 'member' | 'project' | 'chat' | 'model'
export type SpendRange = { from: Date; to: Date }
export type SpendFilter = { current: SpendRange; previous: SpendRange; granularity: SpendGranularity }

export type SpendTotals = { costMicros: number; tokens: number; requests: number }
export type SpendCall = SpendTotals & {
  bucket: string
  prompterId: string
  prompterName: string
  chatId: string
  chatName: string
  projectId: string | null
  projectName: string | null
  model: string
}
export type SpendCounts = SpendTotals & { users: number; sessions: number; turns: number }
export type SpendRow = SpendTotals & { key: string; name: string; share: number }
export type SpendChart = { buckets: string[]; series: { key: string; name: string; costs: number[] }[] }
export const spendFactorNames = [
  'users',
  'sessionsPerUser',
  'turnsPerSession',
  'requestsPerTurn',
  'tokensPerRequest',
  'pricePerToken',
] as const
export type SpendFactorName = (typeof spendFactorNames)[number]
export type SpendFactor = {
  name: SpendFactorName
  current: number | null
  previous: number | null
  change: number | null
}
export type SpendDecomposition = {
  factors: SpendFactor[]
  biggestMover: SpendFactorName | null
  current: SpendCounts
  previous: SpendCounts
}
export type MergedPull = {
  chatId: string
  chatName: string
  repository: string
  number: number
  title: string
  url: string
  costMicros: number
}
export type MergedPullsCost = { pulls: MergedPull[]; costMicros: number; perPullMicros: number | null }
export type SpendReport = {
  from: string
  to: string
  previousFrom: string
  granularity: SpendGranularity
  total: SpendTotals
  charts: Partial<Record<SpendDimension, SpendChart>>
  tables: Partial<Record<SpendDimension, SpendRow[]>>
  decomposition: SpendDecomposition
  mergedPulls: MergedPullsCost | null
}

const dayMilliseconds = 24 * 3_600_000
const maximumCustomDays = 366
const chartSeriesLimit = 5
const datePattern = /^\d{4}-\d{2}-\d{2}$/

const monthStartOf = (date: Date, monthsLater = 0) =>
  new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + monthsLater, 1))
const dayStartOf = (date: Date) => new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()))
const daysLater = (date: Date, days: number) => new Date(date.getTime() + days * dayMilliseconds)
const isoDateOf = (date: Date) => date.toISOString().slice(0, 10)
const precedingRangeOf = ({ from, to }: SpendRange): SpendRange => ({
  from: new Date(from.getTime() - (to.getTime() - from.getTime())),
  to: from,
})

const customDateOf = (value: string | undefined) => {
  const date = new Date(`${value}T00:00:00Z`)
  if (!value || !datePattern.test(value) || Number.isNaN(date.getTime())) throw new InvalidSpendFilter()
  return date
}

const rangesOf = (period: SpendPeriod, query: Readonly<Record<string, string | undefined>>, now: Date) => {
  if (period === 'this_month' || period === 'last_month') {
    const monthsBack = period === 'this_month' ? 0 : -1
    return {
      current: { from: monthStartOf(now, monthsBack), to: monthStartOf(now, monthsBack + 1) },
      previous: { from: monthStartOf(now, monthsBack - 1), to: monthStartOf(now, monthsBack) },
    }
  }
  const current =
    period === 'custom'
      ? { from: customDateOf(query.from), to: daysLater(customDateOf(query.to), 1) }
      : {
          from: daysLater(dayStartOf(now), 1 - (period === 'last_30_days' ? 30 : 90)),
          to: daysLater(dayStartOf(now), 1),
        }
  if (current.to <= current.from || current.to.getTime() - current.from.getTime() > maximumCustomDays * dayMilliseconds)
    throw new InvalidSpendFilter()
  return { current, previous: precedingRangeOf(current) }
}

export const spendFilterFrom = (query: Readonly<Record<string, string | undefined>>, now: Date): SpendFilter => {
  const period = (query.period || 'this_month') as SpendPeriod
  const granularity = (query.granularity || 'day') as SpendGranularity
  if (!spendPeriods.includes(period) || !spendGranularities.includes(granularity)) throw new InvalidSpendFilter()
  return { ...rangesOf(period, query, now), granularity }
}

const bucketStartOf = (date: Date, granularity: SpendGranularity) => {
  if (granularity === 'month') return monthStartOf(date)
  const day = dayStartOf(date)
  return granularity === 'day' ? day : daysLater(day, -((day.getUTCDay() + 6) % 7))
}

export const bucketStartsOf = ({ from, to }: SpendRange, granularity: SpendGranularity) => {
  const starts: string[] = []
  for (
    let start = bucketStartOf(from, granularity);
    start < to;
    start = granularity === 'month' ? monthStartOf(start, 1) : daysLater(start, granularity === 'week' ? 7 : 1)
  )
    starts.push(isoDateOf(start))
  return starts
}

const noSpend: SpendTotals = { costMicros: 0, tokens: 0, requests: 0 }
const addedTotals = (sum: SpendTotals, row: SpendTotals): SpendTotals => ({
  costMicros: sum.costMicros + row.costMicros,
  tokens: sum.tokens + row.tokens,
  requests: sum.requests + row.requests,
})
export const spendTotalOf = (calls: readonly SpendTotals[]) => calls.reduce(addedTotals, noSpend)

const keyAndNameOf = (call: SpendCall, dimension: SpendDimension) =>
  ({
    member: { key: call.prompterId, name: call.prompterName },
    project: { key: call.projectId ?? 'none', name: call.projectName ?? 'No project' },
    chat: { key: call.chatId, name: call.chatName },
    model: { key: call.model, name: call.model },
  })[dimension]

export const spendRowsOf = (calls: readonly SpendCall[], dimension: SpendDimension): SpendRow[] => {
  const rowsByKey = new Map<string, { key: string; name: string } & SpendTotals>()
  for (const call of calls) {
    const { key, name } = keyAndNameOf(call, dimension)
    rowsByKey.set(key, { key, name, ...addedTotals(rowsByKey.get(key) ?? noSpend, call) })
  }
  const totalCost = spendTotalOf(calls).costMicros
  return [...rowsByKey.values()]
    .map((row) => ({ ...row, share: totalCost === 0 ? 0 : row.costMicros / totalCost }))
    .toSorted((first, second) => second.costMicros - first.costMicros || first.name.localeCompare(second.name))
}

export const spendChartOf = (
  calls: readonly SpendCall[],
  dimension: SpendDimension,
  buckets: readonly string[],
): SpendChart => {
  const rows = spendRowsOf(calls, dimension)
  const shownRows = rows.length <= chartSeriesLimit + 1 ? rows : rows.slice(0, chartSeriesLimit)
  const isShown = new Set(shownRows.map((row) => row.key))
  const series = [...shownRows, { key: 'other', name: 'Other' }].map(({ key, name }) => ({
    key,
    name,
    costs: buckets.map(() => 0),
  }))
  for (const call of calls) {
    const callKey = keyAndNameOf(call, dimension).key
    const target = series.find((entry) => entry.key === (isShown.has(callKey) ? callKey : 'other'))
    const bucketIndex = buckets.indexOf(call.bucket)
    if (target && bucketIndex >= 0) target.costs[bucketIndex] = (target.costs[bucketIndex] ?? 0) + call.costMicros
  }
  return { buckets: [...buckets], series: series.filter((entry) => entry.key !== 'other' || entry.costs.some(Boolean)) }
}

const ratioOf = (numerator: number, denominator: number) => (denominator === 0 ? null : numerator / denominator)

const factorValuesOf = (counts: SpendCounts): Record<SpendFactorName, number | null> => ({
  users: counts.users,
  sessionsPerUser: ratioOf(counts.sessions, counts.users),
  turnsPerSession: ratioOf(counts.turns, counts.sessions),
  requestsPerTurn: ratioOf(counts.requests, counts.turns),
  tokensPerRequest: ratioOf(counts.tokens, counts.requests),
  pricePerToken: ratioOf(counts.costMicros, counts.tokens),
})

export const decompositionOf = (current: SpendCounts, previous: SpendCounts): SpendDecomposition => {
  const currentValues = factorValuesOf(current)
  const previousValues = factorValuesOf(previous)
  const factors = spendFactorNames.map((name) => {
    const currentValue = currentValues[name]
    const previousValue = previousValues[name]
    return {
      name,
      current: currentValue,
      previous: previousValue,
      change: currentValue === null || !previousValue ? null : currentValue / previousValue - 1,
    }
  })
  const moves = factors.flatMap(({ name, current: currentValue, previous: previousValue }) =>
    currentValue && previousValue ? [{ name, size: Math.abs(Math.log(currentValue / previousValue)) }] : [],
  )
  const biggest = moves.reduce<(typeof moves)[number] | null>(
    (largest, move) => (move.size > (largest?.size ?? 0) ? move : largest),
    null,
  )
  return { factors, biggestMover: biggest?.name ?? null, current, previous }
}

export const mergedPullsCostOf = (pulls: readonly MergedPull[]): MergedPullsCost => {
  const costMicros = [...new Map(pulls.map((pull) => [pull.chatId, pull.costMicros])).values()].reduce(
    (sum, cost) => sum + cost,
    0,
  )
  return { pulls: [...pulls], costMicros, perPullMicros: pulls.length === 0 ? null : costMicros / pulls.length }
}

export const spendReportOf = ({
  filter,
  calls,
  counts,
  tableDimensions,
  chartDimensions,
  mergedPulls,
}: {
  filter: SpendFilter
  calls: readonly SpendCall[]
  counts: { current: SpendCounts; previous: SpendCounts }
  tableDimensions: readonly SpendDimension[]
  chartDimensions: readonly SpendDimension[]
  mergedPulls: readonly MergedPull[] | null
}): SpendReport => {
  const buckets = bucketStartsOf(filter.current, filter.granularity)
  return {
    from: filter.current.from.toISOString(),
    to: filter.current.to.toISOString(),
    previousFrom: filter.previous.from.toISOString(),
    granularity: filter.granularity,
    total: spendTotalOf(calls),
    charts: Object.fromEntries(
      chartDimensions.map((dimension) => [dimension, spendChartOf(calls, dimension, buckets)]),
    ),
    tables: Object.fromEntries(tableDimensions.map((dimension) => [dimension, spendRowsOf(calls, dimension)])),
    decomposition: decompositionOf(counts.current, counts.previous),
    mergedPulls: mergedPulls && mergedPullsCostOf(mergedPulls),
  }
}

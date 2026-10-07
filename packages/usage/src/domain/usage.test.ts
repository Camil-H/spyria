import { expect, test } from 'bun:test'
import { monthsNewestFirst, nextLogsSince, sumUsage, usageSync } from './usage.ts'

const at = (iso: string) => new Date(iso)
const { overlapMilliseconds } = usageSync

test('the next read starts one overlap before the sync, never moves back, and waits for pending calls', () => {
  const syncedAt = at('2026-10-06T12:00:00Z')
  const overlapBefore = new Date(syncedAt.getTime() - overlapMilliseconds)
  expect(nextLogsSince(at('2026-10-06T11:00:00Z'), { syncedAt })).toEqual(overlapBefore)
  expect(nextLogsSince(at('2026-10-06T11:59:30Z'), { syncedAt })).toEqual(at('2026-10-06T11:59:30Z'))
  expect(nextLogsSince(at('2026-10-06T10:00:00Z'), { syncedAt, oldestPendingAt: at('2026-10-06T11:30:00Z') })).toEqual(
    at('2026-10-06T11:30:00Z'),
  )
})

test('usage sums tokens, cost and calls, and months are listed once, newest first', () => {
  expect(sumUsage([])).toEqual({ tokens: 0, costMicros: 0, calls: 0 })
  expect(
    sumUsage([
      { tokens: 1, costMicros: 2, calls: 3 },
      { tokens: 10, costMicros: 20, calls: 30 },
    ]),
  ).toEqual({ tokens: 11, costMicros: 22, calls: 33 })
  expect(
    monthsNewestFirst([{ month: '2026-08' }, { month: '2026-10' }, { month: '2026-08' }, { month: '2025-12' }]),
  ).toEqual(['2026-10', '2026-08', '2025-12'])
})

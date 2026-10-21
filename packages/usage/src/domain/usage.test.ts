import { expect, test } from 'bun:test'
import { monthsNewestFirst, nextLogsSince, usageSync } from './usage.ts'

const at = (iso: string) => new Date(iso)
const { overlapMilliseconds, pendingHoldMilliseconds } = usageSync

test('the next read starts one overlap before the sync, never moves back, and waits for pending calls', () => {
  const syncedAt = at('2026-10-06T12:00:00Z')
  const overlapBefore = new Date(syncedAt.getTime() - overlapMilliseconds)
  expect(nextLogsSince(at('2026-10-06T11:00:00Z'), { syncedAt })).toEqual(overlapBefore)
  expect(nextLogsSince(at('2026-10-06T11:59:30Z'), { syncedAt })).toEqual(at('2026-10-06T11:59:30Z'))
  expect(nextLogsSince(at('2026-10-06T10:00:00Z'), { syncedAt, oldestPendingAt: at('2026-10-06T11:30:00Z') })).toEqual(
    at('2026-10-06T11:30:00Z'),
  )
})

test('a pending call holds the window for at most the hold, and a full page moves it only to where the page ended', () => {
  const syncedAt = at('2026-10-06T12:00:00Z')
  const longPending = { syncedAt, oldestPendingAt: at('2026-10-06T09:00:00Z') }
  expect(nextLogsSince(at('2026-10-06T08:00:00Z'), longPending)).toEqual(
    new Date(syncedAt.getTime() - pendingHoldMilliseconds),
  )
  expect(
    nextLogsSince(at('2026-09-06T12:00:00Z'), { ...longPending, nextPageFrom: at('2026-09-07T00:00:00Z') }),
  ).toEqual(at('2026-09-07T00:00:00Z'))
})

test('months are listed once, newest first', () => {
  expect(
    monthsNewestFirst([{ month: '2026-08' }, { month: '2026-10' }, { month: '2026-08' }, { month: '2025-12' }]),
  ).toEqual(['2026-10', '2026-08', '2025-12'])
})

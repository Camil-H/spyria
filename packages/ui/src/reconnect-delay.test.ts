import { expect, test } from 'bun:test'
import { reconnectDelayOf } from './reconnect-delay.ts'

const middle = () => 0.5

test('the wait before reconnecting starts at a second and doubles after each failed attempt', () => {
  expect([0, 1, 2, 3, 4].map((failedAttempts) => reconnectDelayOf(failedAttempts, middle))).toEqual([
    1000, 2000, 4000, 8000, 16_000,
  ])
})

test('the wait never exceeds thirty seconds, however many attempts failed', () => {
  expect(reconnectDelayOf(5, middle)).toBe(30_000)
  expect(reconnectDelayOf(50, () => 1)).toBe(30_000)
})

test('the wait is spread by up to a fifth either way so clients do not reconnect all at once', () => {
  expect(reconnectDelayOf(2, () => 0)).toBe(3200)
  expect(reconnectDelayOf(2, () => 1)).toBe(4800)
  expect(reconnectDelayOf(5, () => 0)).toBe(24_000)
})

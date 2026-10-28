import { expect, test } from 'bun:test'
import { dateLabelOf } from './date-label.ts'

const now = new Date('2026-10-27T12:00:00Z')

test('a date reads in the viewer’s time zone, so a message near midnight shows the day the viewer lived it', () => {
  const nearMidnight = new Date('2026-10-01T23:30:00Z')
  expect(dateLabelOf(nearMidnight, now, 'UTC')).toBe('1 Oct')
  expect(dateLabelOf(nearMidnight, now, 'Europe/Paris')).toBe('2 Oct')
})

test('a date of another year shows its year', () => {
  expect(dateLabelOf(new Date('2025-03-04T12:00:00Z'), now, 'UTC')).toBe('4 Mar 2025')
})

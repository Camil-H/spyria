import { expect, test } from 'bun:test'
import { defaultDevLoopSettings, devLoopSettingsFrom, isDevLoopSettings } from './dev-loop.ts'

test('stored dev loop settings read back as they are, a missing value means the loop is off', () => {
  const stored = { checkRounds: 5, reviewRounds: 0, ciRounds: 1, timeLimitMinutes: 90, costLimitMicros: 2_000_000 }
  expect(devLoopSettingsFrom(stored)).toEqual(stored)
  expect(devLoopSettingsFrom(null)).toBeNull()
  expect(devLoopSettingsFrom(undefined)).toBeNull()
})

test('each stored value out of range or of the wrong type falls back to its default, the others are kept', () => {
  expect(devLoopSettingsFrom({ checkRounds: 0, reviewRounds: 2, ciRounds: 'two', timeLimitMinutes: 5 })).toEqual({
    ...defaultDevLoopSettings,
    reviewRounds: 2,
  })
})

test.each([
  [{ ...defaultDevLoopSettings }, true],
  [{ ...defaultDevLoopSettings, costLimitMicros: 1 }, true],
  [{ ...defaultDevLoopSettings, checkRounds: 0 }, false],
  [{ ...defaultDevLoopSettings, reviewRounds: 11 }, false],
  [{ ...defaultDevLoopSettings, ciRounds: 1.5 }, false],
  [{ ...defaultDevLoopSettings, timeLimitMinutes: 24 * 60 + 1 }, false],
  [{ ...defaultDevLoopSettings, costLimitMicros: 0 }, false],
  [{ ...defaultDevLoopSettings, costLimitMicros: undefined }, false],
  [null, false],
])('settings %o are valid: %p', (settings, isValid) => {
  expect(isDevLoopSettings(settings)).toBe(isValid)
})

import { expect, test } from 'bun:test'
import { colorModeOf } from './color-mode.ts'

test('colorModeOf keeps a known mode and falls back to the system one', () => {
  expect(colorModeOf('light')).toBe('light')
  expect(colorModeOf('dark')).toBe('dark')
  expect(colorModeOf('system')).toBe('system')
  expect(colorModeOf(null)).toBe('system')
  expect(colorModeOf('sepia')).toBe('system')
})

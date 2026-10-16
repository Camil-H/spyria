import { expect, test } from 'bun:test'
import { DisplayName } from './display-name.ts'
import { BlankDisplayName } from './errors.ts'

test('DisplayName trims and rejects blank values', () => {
  expect(String(DisplayName('  Alice D.  '))).toBe('Alice D.')
  expect(() => DisplayName('  ')).toThrow(BlankDisplayName)
})

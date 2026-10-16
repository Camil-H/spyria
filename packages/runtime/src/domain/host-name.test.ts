import { expect, test } from 'bun:test'
import { HostName } from './host-name.ts'

test('a host name is trimmed, never blank and at most 60 characters', () => {
  expect<string>(HostName('  Home server ')).toBe('Home server')
  expect(() => HostName('   ')).toThrow('A host name must contain at least one non-blank character')
  expect(HostName('x'.repeat(60))).toHaveLength(60)
  expect(() => HostName('x'.repeat(61))).toThrow('A host name has at most 60 characters')
})

import { expect, test } from 'bun:test'
import { initialsOf } from './Avatar.tsx'

test('initialsOf takes the first letter of the first two words, in capitals', () => {
  expect(initialsOf('alice martin')).toBe('AM')
  expect(initialsOf('  Bob ')).toBe('B')
  expect(initialsOf('Jean Paul Sartre')).toBe('JP')
  expect(initialsOf('Émile')).toBe('É')
  expect(initialsOf('')).toBe('')
})

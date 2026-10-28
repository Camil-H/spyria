import { expect, test } from 'bun:test'
import { shortcutTextOf } from './ShortcutKeys.tsx'

test('a shortcut reads as its keys in capitals, a sequence joined by then', () => {
  expect(shortcutTextOf('l')).toBe('L')
  expect(shortcutTextOf('r 2')).toBe('R then 2')
  expect(shortcutTextOf('/')).toBe('/')
})

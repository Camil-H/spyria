import { expect, test } from 'bun:test'
import { shortcutIndexIn } from './ShortcutLabel.tsx'

test('a label marks its shortcut at the first word starting with it, whatever the case, or nowhere', () => {
  expect(shortcutIndexIn('Left sidebar collapse', 'l')).toBe(0)
  expect(shortcutIndexIn('Workspace settings', 's')).toBe(10)
  expect(shortcutIndexIn('Right sidebar: Sources', 'R')).toBe(0)
  expect(shortcutIndexIn('Profile', 'i')).toBe(-1)
})

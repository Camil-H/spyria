import { expect, test } from 'bun:test'
import { withFoldOpening } from './opened-folds.ts'

test('an opened fold is remembered once, last, and closing it forgets it', () => {
  expect(withFoldOpening(['a:0', 'b:0'], 'a:0', true)).toEqual(['b:0', 'a:0'])
  expect(withFoldOpening(['a:0', 'b:0'], 'a:0', false)).toEqual(['b:0'])
})

test('only the 200 most recently opened folds are remembered', () => {
  const opened = Array.from({ length: 200 }, (_, index) => `turn-${index}:0`)
  const remembered = withFoldOpening(opened, 'newest:0', true)
  expect(remembered).toHaveLength(200)
  expect(remembered[0]).toBe('turn-1:0')
  expect(remembered.at(-1)).toBe('newest:0')
})

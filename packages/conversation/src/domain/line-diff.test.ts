import { expect, test } from 'bun:test'
import { lineDiffOf } from './line-diff.ts'

const numberedLines = (count: number) => Array.from({ length: count }, (_, index) => `line ${index + 1}`)

test('two separate edits in one write become two hunks with their own context and a gap between them', () => {
  const before = numberedLines(20)
  const after = before.map((line, index) => (index === 2 ? 'line 3 changed' : index === 16 ? 'line 17 changed' : line))
  expect(lineDiffOf(before, after)).toEqual([
    { kind: 'context', text: 'line 1' },
    { kind: 'context', text: 'line 2' },
    { kind: 'removed', text: 'line 3' },
    { kind: 'added', text: 'line 3 changed' },
    { kind: 'context', text: 'line 4' },
    { kind: 'context', text: 'line 5' },
    { kind: 'context', text: 'line 6' },
    { kind: 'gap', text: '' },
    { kind: 'context', text: 'line 14' },
    { kind: 'context', text: 'line 15' },
    { kind: 'context', text: 'line 16' },
    { kind: 'removed', text: 'line 17' },
    { kind: 'added', text: 'line 17 changed' },
    { kind: 'context', text: 'line 18' },
    { kind: 'context', text: 'line 19' },
    { kind: 'context', text: 'line 20' },
  ])
})

test('a gap that would hide a single unchanged line shows that line instead', () => {
  const before = numberedLines(9)
  const after = before.map((line, index) => (index === 0 || index === 8 ? `${line} changed` : line))
  const diff = lineDiffOf(before, after)
  expect(diff.some((line) => line.kind === 'gap')).toBe(false)
  expect(diff.filter((line) => line.kind === 'context').map((line) => line.text)).toEqual(before.slice(1, 8))
})

test('edits close together share one hunk, and an insertion and a deletion keep the unchanged lines between them', () => {
  const before = ['a', 'b', 'c', 'd', 'e', 'f']
  const after = ['a', 'inserted', 'b', 'c', 'd', 'f']
  expect(lineDiffOf(before, after)).toEqual([
    { kind: 'context', text: 'a' },
    { kind: 'added', text: 'inserted' },
    { kind: 'context', text: 'b' },
    { kind: 'context', text: 'c' },
    { kind: 'context', text: 'd' },
    { kind: 'removed', text: 'e' },
    { kind: 'context', text: 'f' },
  ])
})

test('repeated lines are matched rather than shown as a whole replaced block', () => {
  const diff = lineDiffOf(['}', 'x', '}', 'y', '}'], ['}', 'y', '}', 'x', '}'])
  expect(diff.filter((line) => line.kind !== 'context')).toHaveLength(4)
})

test('a new file is all added lines, a deleted file all removed lines, and an unchanged file has no diff', () => {
  expect(lineDiffOf([], ['one', 'two'])).toEqual([
    { kind: 'added', text: 'one' },
    { kind: 'added', text: 'two' },
  ])
  expect(lineDiffOf(['one'], [])).toEqual([{ kind: 'removed', text: 'one' }])
  expect(lineDiffOf(['same'], ['same'])).toEqual([])
})

test('a file rewritten beyond the edit budget falls back to one replaced block', () => {
  const before = numberedLines(3000)
  const after = before.map((line) => `${line} rewritten`)
  const diff = lineDiffOf(before, after)
  expect(diff.slice(0, 3000).every((line) => line.kind === 'removed')).toBe(true)
  expect(diff.slice(3000).every((line) => line.kind === 'added')).toBe(true)
})

test('two edits in a 5,000-line file diff within a few times the cost of the same file unchanged, once warm', () => {
  const before = numberedLines(5000)
  const after = before.map((line, index) => (index === 1200 || index === 3800 ? `${line} edited` : line))
  after.splice(2500, 0, 'inserted')
  const unchanged = [...before]
  const millisecondsOf = (diff: () => unknown) => {
    const startedAt = performance.now()
    diff()
    return performance.now() - startedAt
  }
  const medianOf = (durations: number[]) => durations.toSorted((first, second) => first - second)[5] as number
  for (let warmUp = 0; warmUp < 5; warmUp++) {
    lineDiffOf(before, after)
    lineDiffOf(before, unchanged)
  }
  const edited: number[] = []
  const baseline: number[] = []
  for (let round = 0; round < 11; round++) {
    edited.push(millisecondsOf(() => lineDiffOf(before, after)))
    baseline.push(millisecondsOf(() => lineDiffOf(before, unchanged)))
  }
  expect(medianOf(edited) / medianOf(baseline)).toBeLessThan(20)
  const diff = lineDiffOf(before, after)
  expect(diff.filter((line) => line.kind === 'added')).toHaveLength(3)
  expect(diff.filter((line) => line.kind === 'removed')).toHaveLength(2)
})

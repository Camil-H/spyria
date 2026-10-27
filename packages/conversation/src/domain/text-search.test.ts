import { expect, test } from 'bun:test'
import { matchOffsetsIn, matchSpansIn, searchNeedleOf, snippetOf } from './text-search.ts'

test('a search matches every occurrence, whatever its case, without overlapping', () => {
  expect(matchOffsetsIn('Deploy, deploy, DEPLOY', 'deploy')).toEqual([0, 8, 16])
  expect(matchOffsetsIn('aaaa', 'aa')).toEqual([0, 2])
  expect(matchOffsetsIn('nothing here', 'deploy')).toEqual([])
  expect(matchOffsetsIn('anything', '')).toEqual([])
})

test('the searched text ignores surrounding spaces and case', () => {
  expect(searchNeedleOf('  Release Notes ')).toBe('release notes')
})

test('a snippet keeps the match, with its original case, inside a short context on one line', () => {
  const body = `${'word '.repeat(30)}the Release went out\nsmoothly ${'after '.repeat(30)}`
  const snippet = snippetOf(body, 'release')
  expect(snippet.match).toBe('Release')
  expect(snippet.before.startsWith('…')).toBe(true)
  expect(snippet.before.endsWith('the ')).toBe(true)
  expect(snippet.after.startsWith(' went out smoothly')).toBe(true)
  expect(snippet.after.endsWith('…')).toBe(true)
})

test('a short message shows whole, and a message without the match shows its start', () => {
  expect(snippetOf('Ship it today', 'ship')).toEqual({ before: '', match: 'Ship', after: ' it today' })
  expect(snippetOf('Ship it today', 'deploy')).toEqual({ before: '', match: '', after: 'Ship it today' })
})

test('a match spans the formatting inside one block but never joins two blocks', () => {
  const paragraph = { name: 'paragraph' }
  const nextParagraph = { name: 'next paragraph' }
  const segments = [
    { text: 'Ship the ', block: paragraph },
    { text: 'release', block: paragraph },
    { text: ' notes', block: paragraph },
    { text: 'notes later', block: nextParagraph },
  ]
  expect(matchSpansIn(segments, 'the release notes')).toEqual([
    { start: { segment: 0, offset: 5 }, end: { segment: 2, offset: 6 } },
  ])
  expect(matchSpansIn(segments, 'release')).toEqual([
    { start: { segment: 1, offset: 0 }, end: { segment: 1, offset: 7 } },
  ])
  expect(matchSpansIn(segments, 'notesnotes')).toEqual([])
  expect(matchSpansIn(segments, 'notes').map(({ start }) => start)).toEqual([
    { segment: 2, offset: 1 },
    { segment: 3, offset: 0 },
  ])
})

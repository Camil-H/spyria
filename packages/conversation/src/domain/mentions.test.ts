import { expect, test } from 'bun:test'
import { mentionCandidatesOf, mentionQueryAt, mentionSegmentsOf } from './mentions.ts'

const names = ['Alice Martin', 'Bob', 'Bobby Tables', 'Lee Chen']

test.each([
  ['an @ at the start', '@', 1, { start: 0, query: '' }],
  ['a partial name after a space', 'Hi @Ali', 7, { start: 3, query: 'Ali' }],
  ['a name with a space', 'Hi @Alice M', 11, { start: 3, query: 'Alice M' }],
  ['an @ after an opening parenthesis', '(@Bo', 4, { start: 1, query: 'Bo' }],
  ['the word under the caret, not the end of the text', '@Bo and more', 3, { start: 0, query: 'Bo' }],
] as const)('mentionQueryAt finds %s', (_, text, caret, query) => {
  expect(mentionQueryAt(text, caret)).toEqual(query)
})

test.each([
  ['text without an @', 'Hello', 5],
  ['an email address', 'mail alice@example.com', 16],
  ['an @ followed by a space', 'Hi @ there', 10],
  ['a mention on an earlier line', '@Alice\nthanks', 13],
  ['a query longer than any name', `@${'a'.repeat(41)}`, 42],
] as const)('mentionQueryAt finds nothing in %s', (_, text, caret) => {
  expect(mentionQueryAt(text, caret)).toBeUndefined()
})

test('mentionCandidatesOf puts names starting with the query first, then names with a word starting with it', () => {
  expect(mentionCandidatesOf(names, 'b')).toEqual(['Bob', 'Bobby Tables'])
  expect(mentionCandidatesOf(names, 'ch')).toEqual(['Lee Chen'])
  expect(mentionCandidatesOf([...names, 'Chloe'], 'ch')).toEqual(['Chloe', 'Lee Chen'])
  expect(mentionCandidatesOf(names, 'ALICE m')).toEqual(['Alice Martin'])
  expect(mentionCandidatesOf(names, 'z')).toEqual([])
})

test('mentionCandidatesOf lists every member for a bare @, alphabetically and without duplicates, up to six', () => {
  const many = ['Gus', 'Fay', 'Eve', 'Dan', 'Cat', 'Bob', 'Ann', 'Ann']
  expect(mentionCandidatesOf(many, '')).toEqual(['Ann', 'Bob', 'Cat', 'Dan', 'Eve', 'Fay'])
})

test('mentionSegmentsOf marks the members named after an @, the longest name first', () => {
  expect(mentionSegmentsOf('Thanks @Alice Martin and @bobby tables!', names)).toEqual([
    { text: 'Thanks ', isMention: false },
    { text: '@Alice Martin', isMention: true },
    { text: ' and ', isMention: false },
    { text: '@bobby tables', isMention: true },
    { text: '!', isMention: false },
  ])
  expect(mentionSegmentsOf('@Bob', names)).toEqual([{ text: '@Bob', isMention: true }])
})

test.each([
  ['an email address', 'write to bob@example.com'],
  ['a longer word starting with a name', '@Bobcat is here'],
  ['someone who is not a member', '@Zoe'],
])('mentionSegmentsOf leaves %s as plain text', (_, text) => {
  expect(mentionSegmentsOf(text, names)).toEqual([{ text, isMention: false }])
})

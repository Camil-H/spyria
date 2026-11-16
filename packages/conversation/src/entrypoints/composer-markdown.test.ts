import { expect, test } from 'bun:test'
import { styledRunsOf } from './composer-markdown.ts'

const shown = (text: string) =>
  styledRunsOf(text)
    .map(({ text: run, styles }) => (styles.length > 0 ? `[${run}|${styles.join(' ')}]` : run))
    .join('')

test('inline formatting is styled and its markers are set apart', () => {
  expect(shown('say **bold** and *it*')).toBe(
    'say [**|marker strong][bold|strong][**|marker strong] and [*|emphasis marker][it|emphasis][*|emphasis marker]',
  )
  expect(shown('__under__')).toBe('[__|marker underline][under|underline][__|marker underline]')
  expect(shown('~~gone~~ `x`')).toBe(
    '[~~|marker strike][gone|strike][~~|marker strike] [`|code marker][x|code][`|code marker]',
  )
})

test('links show their text as a link and their address as a marker', () => {
  expect(shown('[Docs](https://a.dev)')).toBe('[[|link marker][Docs|link][](https://a.dev)|link marker]')
})

test('headings, list markers, quotes and code fences are styled per line', () => {
  expect(shown('# Title')).toBe('[# |heading marker][Title|heading]')
  expect(shown('- one\n  - two')).toBe('[- |marker]one[\n  - |marker]two')
  expect(shown('> said')).toBe('[> |marker quote][said|quote]')
  expect(shown('```ts\nx\n```')).toBe('[```ts|code marker][\nx\n|code][```|code marker]')
})

test('text being typed stays plain until its formatting closes', () => {
  expect(shown('say **bold')).toBe('say **bold')
  expect(shown('')).toBe('')
})

test('a draft too long to style while typing is shown plain', () => {
  const longDraft = '**bold** '.repeat(500)
  expect(styledRunsOf(longDraft)).toEqual([{ start: 0, text: longDraft, styles: [] }])
})

test('each paragraph is styled on its own, with the blank lines between them kept', () => {
  expect(shown('**a**\n\n- b')).toBe('[**|marker strong][a|strong][**|marker strong]\n\n[- |marker]b')
})

test('a draft that starts with a blank line is shown once', () => {
  expect(shown('\n# Plan')).toBe('\n[# |heading marker][Plan|heading]')
})

import { expect, test } from 'bun:test'
import {
  continuedList,
  type Formatting,
  formattedText,
  formattingOfKey,
  linkedPaste,
  type TextEdit,
  type TextSelection,
} from './composer-formatting.ts'

const selectionOf = (marked: string): TextSelection => {
  const start = marked.indexOf('{')
  const end = marked.indexOf('}') - 1
  return { text: marked.replace('{', '').replace('}', ''), start, end }
}
const applied = ({ text }: TextSelection, edit: TextEdit | undefined) => {
  if (!edit) return undefined
  const result = `${text.slice(0, edit.start)}${edit.insert}${text.slice(edit.end)}`
  return `${result.slice(0, edit.selectStart)}{${result.slice(edit.selectStart, edit.selectEnd)}}${result.slice(edit.selectEnd)}`
}
const formatted = (marked: string, formatting: Formatting) =>
  applied(selectionOf(marked), formattedText(selectionOf(marked), formatting))
const continued = (marked: string) => applied(selectionOf(marked), continuedList(selectionOf(marked)))

test('bold, italic and underline wrap the selection and keep it selected', () => {
  expect(formatted('say {hello} now', 'bold')).toBe('say **{hello}** now')
  expect(formatted('say {hello} now', 'italic')).toBe('say *{hello}* now')
  expect(formatted('say {hello} now', 'underline')).toBe('say __{hello}__ now')
})

test('the same shortcut again removes the markers, around or inside the selection', () => {
  expect(formatted('say **{hello}** now', 'bold')).toBe('say {hello} now')
  expect(formatted('say {**hello**} now', 'bold')).toBe('say {hello} now')
  expect(formatted('say __{hello}__ now', 'underline')).toBe('say {hello} now')
})

test('italic inside bold adds a marker instead of breaking the bold', () => {
  expect(formatted('**{hello}**', 'italic')).toBe('***{hello}***')
  expect(formatted('{**hello**}', 'italic')).toBe('*{**hello**}*')
})

test('an empty selection leaves the cursor between the markers, and a second press removes them', () => {
  expect(formatted('say {}', 'bold')).toBe('say **{}**')
  expect(formatted('say **{}**', 'bold')).toBe('say {}')
})

test('spaces around the selection stay outside the markers', () => {
  expect(formatted('say{ hello }now', 'bold')).toBe('say **{hello}** now')
})

test('code is inline on one line and a fenced block on its own lines across several', () => {
  expect(formatted('run {ls -la} here', 'code')).toBe('run `{ls -la}` here')
  expect(formatted('see:{a\nb}', 'code')).toBe('see:\n```\n{a\nb}\n```')
})

test('a link wraps the text and selects the address to type, or takes a selected address', () => {
  expect(formatted('read {the docs} first', 'link')).toBe('read [the docs]({url}) first')
  expect(formatted('read {https://example.com} first', 'link')).toBe('read [{}](https://example.com) first')
})

test('pasting an address over selected text makes a link; other pastes are left to the browser', () => {
  const selection = selectionOf('read {the docs} first')
  expect(applied(selection, linkedPaste(selection, ' https://example.com/docs '))).toBe(
    'read [the docs](https://example.com/docs){} first',
  )
  expect(linkedPaste(selection, 'plain words')).toBeUndefined()
  expect(linkedPaste(selectionOf('read {} first'), 'https://example.com')).toBeUndefined()
})

test('Enter in a list item starts the next item, numbered or bulleted', () => {
  expect(continued('- milk{}')).toBe('- milk\n- {}')
  expect(continued('  * eggs{}')).toBe('  * eggs\n  * {}')
  expect(continued('1. one\n2. two{}')).toBe('1. one\n2. two\n3. {}')
  expect(continued('- [x] done{}')).toBe('- [x] done\n- [ ] {}')
  expect(continued('plain{}')).toBeUndefined()
  expect(continued('-{}')).toBeUndefined()
})

test('Enter on an empty list item ends the list', () => {
  expect(continued('- milk\n- {}')).toBe('- milk\n{}')
  expect(continued('1. one\n2. {}')).toBe('1. one\n{}')
})

test('shortcuts need the platform key alone, plus Shift only for code', () => {
  const key = (key: string, modifiers: Partial<{ isPrimary: boolean; isShift: boolean; isOtherModifier: boolean }>) =>
    formattingOfKey({ key, isPrimary: true, isShift: false, isOtherModifier: false, ...modifiers })
  expect(key('b', {})).toBe('bold')
  expect(key('B', {})).toBe('bold')
  expect(key('i', {})).toBe('italic')
  expect(key('u', {})).toBe('underline')
  expect(key('k', {})).toBe('link')
  expect(key('C', { isShift: true })).toBe('code')
  expect(key('c', {})).toBeUndefined()
  expect(key('b', { isShift: true })).toBeUndefined()
  expect(key('b', { isPrimary: false })).toBeUndefined()
  expect(key('b', { isOtherModifier: true })).toBeUndefined()
})

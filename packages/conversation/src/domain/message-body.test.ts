import { expect, test } from 'bun:test'
import { BlankMessageBody } from './errors.ts'
import { chatNameFrom, MessageBody } from './message-body.ts'

test.each([
  ['  Hello  ', 'Hello', 'Hello'],
  ['Thanks, glad to be here.', 'Thanks, glad to be here.', 'Thanks, glad to be here.'],
  ['  Fix the bug  \nwith details', 'Fix the bug  \nwith details', 'Fix the bug'],
  ['x'.repeat(70), 'x'.repeat(70), `${'x'.repeat(60)}…`],
])('MessageBody(%p) is %p and names a chat %p', (text, body, chatName) => {
  expect(String(MessageBody(text))).toBe(body)
  expect(chatNameFrom(MessageBody(text))).toBe(chatName)
})

test('MessageBody rejects blank values', () => {
  expect(() => MessageBody('  \n ')).toThrow(BlankMessageBody)
})

test('a blank body is allowed only when asked, for a message that carries attachments', () => {
  expect(String(MessageBody('  ', { allowsBlank: true }))).toBe('')
  expect(chatNameFrom(MessageBody('', { allowsBlank: true }), 'photo.png')).toBe('photo.png')
})

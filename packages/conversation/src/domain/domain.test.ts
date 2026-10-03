import { expect, test } from 'bun:test'
import { chatId, memberId, messageId, workspaceId } from '@hq/kernel'
import { BlankMessageBody, MessageDeleted, NotMessageAuthor } from './errors.ts'
import { deletedMessage, editedMessage, type Message } from './message.ts'
import { chatNameFrom, MessageBody } from './message-body.ts'
import { advancedReadMarker } from './read-marker.ts'

const alice = memberId('alice')
const bob = memberId('bob')
const editedAt = new Date('2026-10-01T12:00:00Z')

const messageByAlice: Message = {
  id: messageId('message'),
  workspaceId: workspaceId('acme'),
  chatId: chatId('chat'),
  kind: 'member',
  authorId: alice,
  body: MessageBody('Hello'),
  detail: null,
  createdAt: new Date('2026-10-01T09:00:00Z'),
  editedAt: null,
  deletedAt: null,
  needsReply: false,
}

test('MessageBody trims its value', () => {
  expect(String(MessageBody('  Hello  '))).toBe('Hello')
})

test('MessageBody rejects blank values', () => {
  expect(() => MessageBody('  \n ')).toThrow(BlankMessageBody)
})

test('editedMessage replaces the body and records the edit time', () => {
  const edited = editedMessage(messageByAlice, alice, MessageBody('Hi'), editedAt)
  expect(edited).toEqual({ ...messageByAlice, body: MessageBody('Hi'), editedAt })
})

test('editedMessage and deletedMessage reject other members', () => {
  expect(() => editedMessage(messageByAlice, bob, MessageBody('Hi'), editedAt)).toThrow(NotMessageAuthor)
  expect(() => deletedMessage(messageByAlice, bob, editedAt)).toThrow(NotMessageAuthor)
})

test('deletedMessage keeps the row and records the deletion time', () => {
  expect(deletedMessage(messageByAlice, alice, editedAt)).toEqual({ ...messageByAlice, deletedAt: editedAt })
})

test('a deleted message can be neither edited nor deleted', () => {
  const deleted = deletedMessage(messageByAlice, alice, editedAt)
  expect(() => editedMessage(deleted, alice, MessageBody('Hi'), editedAt)).toThrow(MessageDeleted)
  expect(() => deletedMessage(deleted, alice, editedAt)).toThrow(MessageDeleted)
})

test('chatNameFrom keeps short single-line messages', () => {
  expect(chatNameFrom(MessageBody('Thanks, glad to be here.'))).toBe('Thanks, glad to be here.')
})

test('chatNameFrom takes the trimmed first line', () => {
  expect(chatNameFrom(MessageBody('  Fix the bug  \nwith details'))).toBe('Fix the bug')
})

test('chatNameFrom truncates long first lines to 60 characters plus an ellipsis', () => {
  expect(chatNameFrom(MessageBody('x'.repeat(70)))).toBe(`${'x'.repeat(60)}…`)
})

test('advancedReadMarker moves the marker to the newest message of the chat', () => {
  const first = messageId('first')
  const second = messageId('second')
  expect(advancedReadMarker(null, [first, second])).toBe(second)
  expect(advancedReadMarker(first, [first, second])).toBe(second)
  expect(advancedReadMarker(second, [first, second])).toBe(second)
})

test('advancedReadMarker leaves a chat without messages unmarked', () => {
  expect(advancedReadMarker(null, [])).toBeNull()
})

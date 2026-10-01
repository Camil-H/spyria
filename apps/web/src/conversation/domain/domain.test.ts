import { expect, test } from 'bun:test'
import { chatId, memberId, messageId, workspaceId } from '@hq/kernel'
import { BlankMessageBody, MessageDeleted, NotMessageAuthor } from './errors.ts'
import { deleteMessage, editMessage, type Message } from './message.ts'
import { chatNameFrom, MessageBody } from './message-body.ts'

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

test('editMessage replaces the body and records the edit time', () => {
  const edited = editMessage(messageByAlice, alice, MessageBody('Hi'), editedAt)
  expect(edited).toEqual({ ...messageByAlice, body: MessageBody('Hi'), editedAt })
})

test('editMessage and deleteMessage reject other members', () => {
  expect(() => editMessage(messageByAlice, bob, MessageBody('Hi'), editedAt)).toThrow(NotMessageAuthor)
  expect(() => deleteMessage(messageByAlice, bob, editedAt)).toThrow(NotMessageAuthor)
})

test('deleteMessage keeps the row and records the deletion time', () => {
  expect(deleteMessage(messageByAlice, alice, editedAt)).toEqual({ ...messageByAlice, deletedAt: editedAt })
})

test('a deleted message can be neither edited nor deleted', () => {
  const deleted = deleteMessage(messageByAlice, alice, editedAt)
  expect(() => editMessage(deleted, alice, MessageBody('Hi'), editedAt)).toThrow(MessageDeleted)
  expect(() => deleteMessage(deleted, alice, editedAt)).toThrow(MessageDeleted)
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

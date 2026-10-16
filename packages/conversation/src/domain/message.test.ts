import { expect, test } from 'bun:test'
import { chatId, memberId, messageId, workspaceId } from '@hq/kernel'
import { MessageDeleted, NotMessageAuthor } from './errors.ts'
import { deletedMessage, editedMessage, type Message } from './message.ts'
import { MessageBody } from './message-body.ts'

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
  step: null,
  createdAt: new Date('2026-10-01T09:00:00Z'),
  editedAt: null,
  deletedAt: null,
  replyToId: null,
}

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

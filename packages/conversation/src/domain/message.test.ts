import { expect, test } from 'bun:test'
import { chatId, memberId, messageId, workspaceId } from '@spyria/kernel'
import { ChatFrozen, InvalidThreadRoot, MessageDeleted, NoThreadsInRuntimeChat, NotMessageAuthor } from './errors.ts'
import {
  type ConversationChat,
  deletedMessage,
  editedMessage,
  isAgentActivity,
  type Message,
  requireNotFrozen,
  threadRootOf,
} from './message.ts'
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
  attachments: [],
  detail: null,
  step: null,
  createdAt: new Date('2026-10-01T09:00:00Z'),
  editedAt: null,
  deletedAt: null,
  replyToId: null,
  threadRootId: null,
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

const channel: ConversationChat = {
  workspaceId: workspaceId('acme'),
  name: 'Welcome',
  type: 'channel',
  visibility: 'public',
  harness: null,
  ownerId: alice,
  localSession: null,
  baseBranch: null,
  isOwnerRemoved: false,
}

test('threadRootOf accepts a top-level message of the same channel that is not deleted', () => {
  expect(threadRootOf(channel, chatId('chat'), messageByAlice)).toBe(messageId('message'))
})

test.each<[string, Message | undefined, string]>([
  ['a missing message', undefined, 'chat'],
  ['a message of another chat', messageByAlice, 'chat-other'],
  ['a reply', { ...messageByAlice, threadRootId: messageId('root') }, 'chat'],
  ['a deleted message', { ...messageByAlice, deletedAt: editedAt }, 'chat'],
])('threadRootOf refuses %s', (_, root, chat) => {
  expect(() => threadRootOf(channel, chatId(chat), root)).toThrow(InvalidThreadRoot)
})

test('threadRootOf refuses any root in a runtime chat', () => {
  expect(() => threadRootOf({ ...channel, type: 'runtime' }, chatId('chat'), messageByAlice)).toThrow(
    NoThreadsInRuntimeChat,
  )
})

test('requireNotFrozen refuses a runtime chat whose owner was removed and allows any other, channels included', () => {
  expect(() => requireNotFrozen({ ...channel, type: 'runtime', isOwnerRemoved: true })).toThrow(ChatFrozen)
  expect(() => requireNotFrozen({ ...channel, type: 'runtime' })).not.toThrow()
  expect(() => requireNotFrozen({ ...channel, isOwnerRemoved: true })).not.toThrow()
})

test('only what the agent wrote is agent activity: its replies and steps, not a member’s pull request card or messages', () => {
  const alice = memberId('alice')
  expect(isAgentActivity({ kind: 'agent', authorId: null })).toBe(true)
  expect(isAgentActivity({ kind: 'step', authorId: null })).toBe(true)
  expect(isAgentActivity({ kind: 'step', authorId: alice })).toBe(false)
  expect(isAgentActivity({ kind: 'member', authorId: alice })).toBe(false)
  expect(isAgentActivity({ kind: 'notice', authorId: null })).toBe(false)
})

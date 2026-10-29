import { expect, test } from 'bun:test'
import { chatId, memberId, messageId, workspaceId } from '@spyria/kernel'
import {
  ChatFrozen,
  InvalidQuotedMessage,
  InvalidThreadRoot,
  MessageDeleted,
  NoThreadsInRuntimeChat,
  NotMessageAuthor,
} from './errors.ts'
import {
  type ConversationChat,
  deletedMessage,
  editedMessage,
  isAgentActivity,
  type Message,
  quotedMessageOf,
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
  step: null,
  createdAt: new Date('2026-10-01T09:00:00Z'),
  editedAt: null,
  status: 'live',
  replyToId: null,
  threadRootId: null,
  quotedMessageId: null,
}

test('editedMessage and deletedMessage reject other members', () => {
  expect(() => editedMessage(messageByAlice, bob, MessageBody('Hi'), editedAt)).toThrow(NotMessageAuthor)
  expect(() => deletedMessage(messageByAlice, bob, editedAt)).toThrow(NotMessageAuthor)
})

test('deletedMessage turns a live message into a tombstone that keeps its body and drops its attachments', () => {
  const photo = { id: 'attachment-1', name: 'photo.png', mediaType: 'image/png', size: 2048 }
  expect(deletedMessage({ ...messageByAlice, attachments: [photo] }, alice, editedAt)).toEqual({
    ...messageByAlice,
    status: 'deleted',
    body: MessageBody('Hello'),
    attachments: [],
    deletedAt: editedAt,
  })
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
  ['a deleted message', { ...messageByAlice, status: 'deleted', deletedAt: editedAt }, 'chat'],
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

test('quotedMessageOf accepts a member’s or the agent’s live message of the same chat, a thread reply included', () => {
  expect(quotedMessageOf(chatId('chat'), messageByAlice)).toBe(messageId('message'))
  expect(quotedMessageOf(chatId('chat'), { ...messageByAlice, kind: 'agent', authorId: null })).toBe(
    messageId('message'),
  )
  expect(quotedMessageOf(chatId('chat'), { ...messageByAlice, threadRootId: messageId('root') })).toBe(
    messageId('message'),
  )
})

test.each<[string, Message | undefined, string]>([
  ['a missing message', undefined, 'chat'],
  ['a message of another chat', messageByAlice, 'chat-other'],
  ['a deleted message', { ...messageByAlice, status: 'deleted', deletedAt: editedAt }, 'chat'],
  ['an agent step', { ...messageByAlice, kind: 'step', authorId: null }, 'chat'],
  ['a notice', { ...messageByAlice, kind: 'notice', authorId: null }, 'chat'],
])('quotedMessageOf refuses %s', (_, quoted, chat) => {
  expect(() => quotedMessageOf(chatId(chat), quoted)).toThrow(InvalidQuotedMessage)
})

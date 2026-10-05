import { expect, test } from 'bun:test'
import { chatId, memberId, messageId, workspaceId } from '@hq/kernel'
import { BlankMessageBody, MessageDeleted, NotMessageAuthor } from './errors.ts'
import { deletedMessage, editedMessage, type Message } from './message.ts'
import { chatNameFrom, MessageBody } from './message-body.ts'
import { messagesFromEvents, type StoredEvent } from './message-events.ts'

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
  replyToId: null,
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

const minute = (value: number) => new Date(Date.UTC(2026, 9, 1, 9, value))
const eventAt = (
  seq: number,
  type: string,
  actor: string | null,
  payload: unknown,
  id = `event-${seq}`,
): StoredEvent => ({
  workspaceId: 'acme',
  chatId: 'chat',
  id,
  seq,
  type,
  actor,
  payload,
  createdAt: minute(seq),
})
const posted = { kind: 'member', detail: null, replyToId: null } as const

test('messagesFromEvents folds posted, replied, edited and deleted events into message rows', () => {
  expect(
    messagesFromEvents([
      eventAt(1, 'message.posted', 'alice', { ...posted, body: 'Hello' }, 'question'),
      eventAt(
        2,
        'message.replied',
        null,
        { kind: 'agent', body: 'Hi', detail: 'Read 2 files', replyToId: 'question' },
        'answer',
      ),
      eventAt(3, 'message.edited', 'alice', { messageId: 'question', body: 'Hello there' }),
      eventAt(4, 'message.posted', 'alice', { ...posted, body: 'Oops' }, 'mistake'),
      eventAt(5, 'message.deleted', 'alice', { messageId: 'mistake' }),
    ]),
  ).toEqual([
    {
      workspaceId: 'acme',
      chatId: 'chat',
      id: 'question',
      seq: 1,
      kind: 'member',
      authorId: 'alice',
      body: 'Hello there',
      detail: null,
      replyToId: null,
      createdAt: minute(1),
      editedAt: minute(3),
      deletedAt: null,
    },
    {
      workspaceId: 'acme',
      chatId: 'chat',
      id: 'answer',
      seq: 2,
      kind: 'agent',
      authorId: null,
      body: 'Hi',
      detail: 'Read 2 files',
      replyToId: 'question',
      createdAt: minute(2),
      editedAt: null,
      deletedAt: null,
    },
    {
      workspaceId: 'acme',
      chatId: 'chat',
      id: 'mistake',
      seq: 4,
      kind: 'member',
      authorId: 'alice',
      body: '',
      detail: null,
      replyToId: null,
      createdAt: minute(4),
      editedAt: null,
      deletedAt: minute(5),
    },
  ])
})

test('messagesFromEvents ignores chat events', () => {
  const message = eventAt(2, 'message.posted', 'alice', { ...posted, body: 'Hello' }, 'hello')
  const chatEvents = [
    eventAt(1, 'chat.created', 'alice', { name: 'Chat', type: 'channel', projectId: null }),
    eventAt(3, 'chat.renamed', 'alice', { name: 'Renamed' }),
    eventAt(4, 'chat.moved', 'alice', { projectId: 'project' }),
    eventAt(5, 'chat.archived', 'alice', {}),
  ]
  expect(messagesFromEvents(chatEvents)).toEqual([])
  expect(messagesFromEvents([...chatEvents, message])).toEqual(messagesFromEvents([message]))
})

test('messagesFromEvents keeps messages of different workspaces apart', () => {
  const inGlobex = {
    ...eventAt(1, 'message.posted', 'alice', { ...posted, body: 'Hello' }, 'same-id'),
    workspaceId: 'globex',
  }
  const inAcme = eventAt(1, 'message.posted', 'alice', { ...posted, body: 'Hello' }, 'same-id')
  expect(
    messagesFromEvents([inGlobex, inAcme, eventAt(2, 'message.deleted', 'alice', { messageId: 'same-id' })]).map(
      ({ workspaceId, body }) => ({ workspaceId, body }),
    ),
  ).toEqual([
    { workspaceId: 'globex', body: 'Hello' },
    { workspaceId: 'acme', body: '' },
  ])
})

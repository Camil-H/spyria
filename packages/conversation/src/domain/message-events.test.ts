import { expect, test } from 'bun:test'
import { messagesFromEvents, type StoredEvent } from './message-events.ts'

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

test('messagesFromEvents folds posted, replied, thread reply, edited and deleted events into message rows', () => {
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
      eventAt(4, 'message.posted', 'alice', { ...posted, body: 'Oops', threadRootId: 'question' }, 'mistake'),
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
      step: null,
      replyToId: null,
      threadRootId: null,
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
      step: null,
      replyToId: 'question',
      threadRootId: null,
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
      step: null,
      replyToId: null,
      threadRootId: 'question',
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

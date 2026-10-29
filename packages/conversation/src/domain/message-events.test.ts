import { expect, test } from 'bun:test'
import { actorOf } from '@spyria/kernel'
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
  actor: actorOf({ kind: null, id: actor, onBehalfOf: null }),
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
      attachments: [],
      detail: null,
      step: null,
      replyToId: null,
      threadRootId: null,
      quotedMessageId: null,
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
      attachments: [],
      detail: 'Read 2 files',
      step: null,
      replyToId: 'question',
      threadRootId: null,
      quotedMessageId: null,
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
      attachments: [],
      detail: null,
      step: null,
      replyToId: null,
      threadRootId: 'question',
      quotedMessageId: null,
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

test('a posted step keeps its step and a step change replaces it in place', () => {
  const card = { type: 'pull_request', number: 1, state: 'open' }
  const [projected] = messagesFromEvents([
    eventAt(
      1,
      'message.posted',
      'alice',
      { kind: 'step', body: 'pull_request', detail: null, replyToId: null, step: card },
      'card',
    ),
    eventAt(2, 'message.step_changed', null, { messageId: 'card', step: { ...card, state: 'merged' } }),
    eventAt(3, 'message.step_changed', null, { messageId: 'unknown', step: card }),
  ])
  expect(projected).toMatchObject({ id: 'card', seq: 1, kind: 'step', authorId: 'alice', step: { state: 'merged' } })
})

test('messagesFromEvents keeps attachments through an edit and drops them with a deletion', () => {
  const photo = { id: 'attachment-1', name: 'photo.png', mediaType: 'image/png', size: 2048 }
  const attachmentsAfter = (...later: StoredEvent[]) =>
    messagesFromEvents([
      eventAt(1, 'message.posted', 'alice', { ...posted, body: '', attachments: [photo] }, 'photo'),
      ...later,
    ]).map(({ body, attachments }) => ({ body, attachments }))
  expect(attachmentsAfter()).toEqual([{ body: '', attachments: [photo] }])
  expect(attachmentsAfter(eventAt(2, 'message.edited', 'alice', { messageId: 'photo', body: 'Look' }))).toEqual([
    { body: 'Look', attachments: [photo] },
  ])
  expect(attachmentsAfter(eventAt(2, 'message.deleted', 'alice', { messageId: 'photo' }))).toEqual([
    { body: '', attachments: [] },
  ])
})

test('a posted reply keeps the message it quotes, also in a thread', () => {
  const [, reply, threadReply] = messagesFromEvents([
    eventAt(1, 'message.posted', 'alice', { ...posted, body: 'Hello' }, 'hello'),
    eventAt(2, 'message.posted', 'bob', { ...posted, body: 'Hi', quotedMessageId: 'hello' }, 'reply'),
    eventAt(3, 'message.posted', 'bob', { ...posted, body: 'Yes', threadRootId: 'hello', quotedMessageId: 'reply' }),
  ])
  expect(reply).toMatchObject({ id: 'reply', quotedMessageId: 'hello', threadRootId: null })
  expect(threadReply).toMatchObject({ quotedMessageId: 'reply', threadRootId: 'hello' })
})

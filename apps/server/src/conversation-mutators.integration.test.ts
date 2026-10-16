import { expect, test } from 'bun:test'
import { events, jobs } from '@hq/db/postgres'
import {
  acme,
  alice,
  aliceInAcme,
  failedWith,
  globex,
  openSharedTestApp,
  bob,
  bobInAcme,
  succeeded,
} from './testing/testing.ts'

const { database, resultOf, eventsOf, changesOf, chatRow, messagesOf } = await openSharedTestApp()

const messageRow = (id: string) => database.query.messages.findFirst({ where: { id } })
const jobsOf = async (messageId: string) =>
  (await database.select().from(jobs)).filter((job) => (job.payload as { messageId: string }).messageId === messageId)
const countOf = async () => ({
  messages: (await database.query.messages.findMany()).length,
  events: (await database.select().from(events)).length,
  jobs: (await database.select().from(jobs)).length,
  chats: (await database.query.chats.findMany()).length,
})
const sendTo = (member: typeof aliceInAcme, chatId: string, id: string, text: string) =>
  resultOf(member, 'conversation.sendMessage', { workspaceId: member.workspaceId, id, chatId, text })

test('sendMessage in a channel appends a posted event and the projection at the next seq, without a job', async () => {
  const before = Date.now()
  expect(await sendTo(aliceInAcme, 'chat-welcome', 'message-sent', '  Hello  ')).toEqual(succeeded)
  const message = await messageRow('message-sent')
  expect(message).toMatchObject({ chatId: 'chat-welcome', seq: 3, kind: 'member', authorId: alice, body: 'Hello' })
  expect(message?.createdAt.getTime()).toBeGreaterThanOrEqual(before)
  expect((await eventsOf('chat-welcome')).at(-1)).toMatchObject({
    id: 'message-sent',
    seq: 3,
    type: 'message.posted',
    actor: alice,
    payload: { kind: 'member', body: 'Hello', detail: null, replyToId: null },
  })
  expect(await jobsOf('message-sent')).toEqual([])
})

test('sendMessage in a runtime chat enqueues one agent prompt job in the same transaction', async () => {
  expect(await sendTo(aliceInAcme, 'chat-invoice-bug', 'message-to-agent', 'Fix it')).toEqual(succeeded)
  expect(await messageRow('message-to-agent')).toMatchObject({ seq: 5, replyToId: null })
  expect(await jobsOf('message-to-agent')).toMatchObject([
    { workspaceId: acme, type: 'agent.prompt', attempts: 0, state: 'queued' },
  ])
})

test('editMessage and deleteMessage append events, edit the projection and blank a deleted body', async () => {
  await sendTo(bobInAcme, 'chat-standup', 'message-to-change', 'Draft plan')
  expect(
    await resultOf(bobInAcme, 'conversation.editMessage', {
      workspaceId: acme,
      messageId: 'message-to-change',
      text: 'Final plan',
    }),
  ).toEqual(succeeded)
  expect(await messageRow('message-to-change')).toMatchObject({ body: 'Final plan', deletedAt: null })
  expect((await messageRow('message-to-change'))?.editedAt).not.toBeNull()
  expect(
    await resultOf(bobInAcme, 'conversation.deleteMessage', { workspaceId: acme, messageId: 'message-to-change' }),
  ).toEqual(succeeded)
  expect(await messageRow('message-to-change')).toMatchObject({ seq: 2, body: '' })
  expect((await messageRow('message-to-change'))?.deletedAt).not.toBeNull()
  expect(await changesOf('chat-standup')).toEqual([
    { seq: 1, type: 'message.posted', actor: bob, payload: expect.anything() },
    { seq: 2, type: 'message.posted', actor: bob, payload: expect.objectContaining({ body: 'Draft plan' }) },
    { seq: 3, type: 'message.edited', actor: bob, payload: { messageId: 'message-to-change', body: 'Final plan' } },
    { seq: 4, type: 'message.deleted', actor: bob, payload: { messageId: 'message-to-change' } },
  ])
})

test('markChatRead moves the marker to the newest seq and never backwards', async () => {
  const markerOf = (chatId: string) =>
    database.query.readMarkers.findFirst({ where: { chatId, userId: alice } }).then((marker) => marker?.lastReadSeq)
  expect(
    await resultOf(aliceInAcme, 'conversation.markChatRead', { workspaceId: acme, chatId: 'chat-standup' }),
  ).toEqual(succeeded)
  expect(await markerOf('chat-standup')).toBe(2)
  await database.$client`update read_markers set last_read_seq = 99 where chat_id = 'chat-standup' and user_id = ${alice}`
  expect(
    await resultOf(aliceInAcme, 'conversation.markChatRead', { workspaceId: acme, chatId: 'chat-standup' }),
  ).toEqual(succeeded)
  expect(await markerOf('chat-standup')).toBe(99)
})

test('startRuntimeFromMessage creates the runtime chat and its seed message in one mutation, without a job', async () => {
  expect(
    await resultOf(aliceInAcme, 'conversation.startRuntimeFromMessage', {
      workspaceId: acme,
      id: 'message-seed',
      chatId: 'chat-started',
      messageId: 'message-welcome-1',
    }),
  ).toEqual(succeeded)
  expect(await chatRow('chat-started')).toMatchObject({
    type: 'runtime',
    name: 'Welcome to the team!',
    originChatId: 'chat-welcome',
    projectId: 'project-onboarding',
    ownerUserId: alice,
  })
  expect(await messagesOf('chat-started')).toMatchObject([
    { id: 'message-seed', seq: 2, authorId: alice, body: 'Welcome to the team!', replyToId: 'message-welcome-1' },
  ])
  expect(await changesOf('chat-started')).toEqual([
    {
      seq: 1,
      type: 'chat.created',
      actor: alice,
      payload: { name: 'Welcome to the team!', type: 'runtime', projectId: 'project-onboarding' },
    },
    {
      seq: 2,
      type: 'message.posted',
      actor: alice,
      payload: expect.objectContaining({ replyToId: 'message-welcome-1' }),
    },
  ])
  expect((await eventsOf('chat-started'))[1]?.id).toBe('message-seed')
  expect(await jobsOf('message-seed')).toEqual([])
})

test('startRuntimeFromMessage rolls the new chat back when its seed message cannot be written', async () => {
  const before = await countOf()
  expect(
    await resultOf(aliceInAcme, 'conversation.startRuntimeFromMessage', {
      workspaceId: acme,
      id: 'message-welcome-2',
      chatId: 'chat-half-started',
      messageId: 'message-welcome-1',
    }),
  ).toMatchObject({ error: 'app' })
  expect(await chatRow('chat-half-started')).toBeUndefined()
  expect(await countOf()).toEqual(before)
})

test('a new runtime chat has no model before its first prompt and the auto policy, stored per chat, with no default model', async () => {
  const routing = (fields: Record<string, unknown>) =>
    resultOf(aliceInAcme, 'conversation.updateChatRouting', { workspaceId: acme, chatId: 'chat-routed', ...fields })
  expect(
    await resultOf(aliceInAcme, 'workspace.createChat', {
      workspaceId: acme,
      id: 'chat-routed',
      name: 'Routed',
      type: 'runtime',
      projectId: null,
    }),
  ).toEqual(succeeded)
  expect(await chatRow('chat-routed')).toMatchObject({ subagentPolicy: 'auto', model: null, reasoningEffort: null })
  expect(await routing({ defaultModel: 'fake/fake-small', subagentPolicy: 'same_as_main' })).toEqual(succeeded)
  expect(await chatRow('chat-routed')).toMatchObject({ subagentPolicy: 'same_as_main', model: null })
  expect(await chatRow('chat-routed')).not.toHaveProperty('defaultModel')
})

test.each([
  [
    'sendMessage to a chat of another workspace',
    'conversation.sendMessage',
    { id: 'message-x', chatId: 'chat-launch-plan', text: 'Hi' },
    'Chat chat-launch-plan was not found',
  ],
  [
    'editMessage of another workspace',
    'conversation.editMessage',
    { messageId: 'message-general-1', text: 'Taken' },
    'Message message-general-1 was not found',
  ],
  [
    'deleteMessage of another workspace',
    'conversation.deleteMessage',
    { messageId: 'message-general-1' },
    'Message message-general-1 was not found',
  ],
  [
    'startRuntimeFromMessage from another workspace',
    'conversation.startRuntimeFromMessage',
    { id: 'message-y', chatId: 'chat-y', messageId: 'message-general-1' },
    'Message message-general-1 was not found',
  ],
  [
    'editMessage of another member',
    'conversation.editMessage',
    { messageId: 'message-welcome-2', text: 'Taken' },
    'Only the author can change a message',
  ],
  [
    'deleteMessage of another member',
    'conversation.deleteMessage',
    { messageId: 'message-welcome-2' },
    'Only the author can change a message',
  ],
  [
    'a blank message',
    'conversation.sendMessage',
    { id: 'message-blank', chatId: 'chat-welcome', text: '  ' },
    'A message must contain at least one non-blank character',
  ],
  [
    'arguments naming another workspace than the token',
    'conversation.sendMessage',
    { workspaceId: globex, id: 'message-foreign', chatId: 'chat-general', text: 'Hi' },
    'The change targets a workspace other than the current one',
  ],
])('refuses %s and writes nothing', async (_, name, args, message) => {
  const before = await countOf()
  expect(await resultOf(bobInAcme, name, { workspaceId: acme, ...args })).toEqual(failedWith(message))
  expect(await countOf()).toEqual(before)
})

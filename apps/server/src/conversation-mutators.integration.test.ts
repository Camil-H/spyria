import { expect, test } from 'bun:test'
import { createApp } from './app.ts'
import { createRateLimiter, rateBudgets } from './rate-limits.ts'
import {
  acme,
  alice,
  aliceInAcme,
  bob,
  bobInAcme,
  countOf,
  failedWith,
  globex,
  jobsOf,
  messageRow,
  openSharedTestApp,
  requestMutation,
  sendTo,
  succeeded,
  testAuthSettings,
} from './testing/testing.ts'

const { database, resultOf, eventsOf, changesOf, chatRow } = await openSharedTestApp()

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

test('editMessage and deleteMessage append events and edit the projection, and a deletion blanks the body in the row and in the earlier events, keeping the last text only for the audit log', async () => {
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
    { seq: 2, type: 'message.posted', actor: bob, payload: expect.objectContaining({ body: '', redacted: true }) },
    {
      seq: 3,
      type: 'message.edited',
      actor: bob,
      payload: { messageId: 'message-to-change', body: '', redacted: true },
    },
    { seq: 4, type: 'message.deleted', actor: bob, payload: { messageId: 'message-to-change' } },
  ])
  expect([
    ...(await database.$client`
      select chat_id as "chatId", body, deleted_by as "deletedBy" from deleted_message_texts
      where message_id = 'message-to-change'`),
  ]).toEqual([{ chatId: 'chat-standup', body: 'Final plan', deletedBy: bob }])
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
  expect(await routing({ defaultModel: 'mistral/mistral-small-latest', subagentPolicy: 'same_as_main' })).toEqual(
    succeeded,
  )
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

test('a member prompts the agent at most 30 times a minute and posts at most 120 non-prompting messages a minute: the next one is refused with the rate-limit message and not written, a channel post still goes through after the prompts run out, another member still posts', async () => {
  const frozenAt = Date.now()
  const rateLimiter = createRateLimiter(rateBudgets, () => frozenAt)
  const limitedApp = createApp({ database, ...testAuthSettings, rateLimiter })
  const send = (member: typeof aliceInAcme, chatId: string, id: string) =>
    requestMutation(limitedApp, database, member, 'conversation.sendMessage', {
      workspaceId: acme,
      chatId,
      id,
      text: 'Hi',
    })
  const refusedFor = (seconds: number) => failedWith(`Too many requests: try again in ${seconds} seconds.`)
  for (let sent = 0; sent < rateBudgets.prompts.count; sent++)
    expect(await send(aliceInAcme, 'chat-invoice-bug', `message-prompt-${sent}`)).toEqual(succeeded)
  expect(await send(aliceInAcme, 'chat-invoice-bug', 'message-prompt-over')).toEqual(refusedFor(2))
  expect(await messageRow('message-prompt-over')).toBeUndefined()
  for (let posted = 0; posted < rateBudgets.messages.count; posted++)
    expect(await send(aliceInAcme, 'chat-welcome', `message-post-${posted}`)).toEqual(succeeded)
  expect(await send(aliceInAcme, 'chat-welcome', 'message-post-over')).toEqual(refusedFor(1))
  expect(await messageRow('message-post-over')).toBeUndefined()
  expect(await send(bobInAcme, 'chat-welcome', 'message-post-bob')).toEqual(succeeded)
})

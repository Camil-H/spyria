import { expect, test } from 'bun:test'
import { events, jobs } from '@hq/db/postgres'
import {
  acme,
  alice,
  aliceInAcme,
  chatAccessRows,
  chatAs,
  failedWith,
  globex,
  lee,
  missingPermission,
  newChat,
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
    visibility: 'private',
  })
  expect(await database.$client`select user_id, role_id from chat_participants where chat_id = 'chat-started'`).toEqual(
    [{ user_id: alice, role_id: 'owner' }] as never,
  )
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

const writtenMessage = async (chatId: string, authorId: string) => {
  const id = `message-${crypto.randomUUID()}`
  await database.$client`
    insert into messages (workspace_id, chat_id, id, seq, kind, author_id, body, created_at)
    values (${acme}, ${chatId}, ${id}, 1, 'member', ${authorId}, 'Written before', now())`
  return id
}
const posters = ['prompter', 'editor', 'owner', 'public'] as const
const readers = ['reader', 'prompter', 'editor', 'owner', 'public'] as const
const configurers = ['editor', 'owner'] as const

test.each(chatAccessRows(posters))('sendMessage needs chat.post: $name', async ({ member, isAllowed, ...role }) => {
  const chat = await chatAs(role, 'channel')
  const before = await countOf()
  const result = await sendTo(member, chat, `message-${crypto.randomUUID()}`, 'Hi')
  expect(result).toEqual(isAllowed ? succeeded : missingPermission('chat.post'))
  if (!isAllowed) expect(await countOf()).toEqual(before)
})

test.each(chatAccessRows(posters))(
  'editMessage and deleteMessage need the author and chat.post: $name',
  async ({ member, isAllowed, ...role }) => {
    const chat = await chatAs(role, 'channel')
    const own = await writtenMessage(chat, member.userId)
    const expected = isAllowed ? succeeded : missingPermission('chat.post')
    expect(
      await resultOf(member, 'conversation.editMessage', { workspaceId: acme, messageId: own, text: 'New' }),
    ).toEqual(expected)
    expect(await resultOf(member, 'conversation.deleteMessage', { workspaceId: acme, messageId: own })).toEqual(
      expected,
    )
    expect((await messageRow(own))?.body).toBe(isAllowed ? '' : 'Written before')
  },
)

test.each(chatAccessRows(readers))('markChatRead needs chat.read: $name', async ({ member, isAllowed, ...role }) => {
  const chat = await chatAs(role)
  await writtenMessage(chat, alice)
  expect(await resultOf(member, 'conversation.markChatRead', { workspaceId: acme, chatId: chat })).toEqual(
    isAllowed ? succeeded : missingPermission('chat.read'),
  )
  expect(await database.query.readMarkers.findFirst({ where: { chatId: chat, userId: member.userId } })).toEqual(
    isAllowed ? expect.objectContaining({ lastReadSeq: 1 }) : undefined,
  )
})

test.each(chatAccessRows(posters))(
  'retryAgent needs chat.post before it looks at the runtime: $name',
  async ({ member, isAllowed, ...role }) => {
    const chat = await chatAs(role)
    expect(await resultOf(member, 'conversation.retryAgent', { workspaceId: acme, chatId: chat })).toEqual(
      isAllowed ? failedWith('Only a runtime that could not start can be retried') : missingPermission('chat.post'),
    )
  },
)

test.each(chatAccessRows(configurers))(
  'stopAgent needs session.configure: $name',
  async ({ member, isAllowed, ...role }) => {
    const chat = await chatAs(role)
    expect(await resultOf(member, 'conversation.stopAgent', { workspaceId: acme, chatId: chat })).toEqual(
      isAllowed ? succeeded : missingPermission('session.configure'),
    )
  },
)

test.each(chatAccessRows(configurers))(
  'updateChatRouting of the model, subagents and Pi effort needs session.configure: $name',
  async ({ member, isAllowed, ...role }) => {
    const chat = await chatAs(role)
    expect(
      await resultOf(member, 'conversation.updateChatRouting', {
        workspaceId: acme,
        chatId: chat,
        subagentPolicy: 'same_as_main',
        reasoningEffort: 'high',
      }),
    ).toEqual(isAllowed ? succeeded : missingPermission('session.configure'))
    expect(await chatRow(chat)).toMatchObject(
      isAllowed ? { subagentPolicy: 'same_as_main', reasoningEffort: 'high' } : { reasoningEffort: null },
    )
  },
)

test('an editor configures the session but where it runs stays the owner’s choice', async () => {
  const chat = await chatAs({ isPublic: false, roleId: 'editor', userId: bob })
  expect(
    await resultOf(bobInAcme, 'conversation.updateChatRouting', { workspaceId: acme, chatId: chat, runsOn: 'runtime' }),
  ).toEqual(failedWith('Only the owner changes how this session runs'))
})

test.each(chatAccessRows(readers))(
  'startRuntimeFromMessage needs chat.read on the source chat: $name',
  async ({ member, isAllowed, ...role }) => {
    const source = await chatAs(role, 'channel')
    const sourceMessage = await writtenMessage(source, alice)
    const started = `chat-${crypto.randomUUID()}`
    expect(
      await resultOf(member, 'conversation.startRuntimeFromMessage', {
        workspaceId: acme,
        id: `message-${crypto.randomUUID()}`,
        chatId: started,
        messageId: sourceMessage,
      }),
    ).toEqual(isAllowed ? succeeded : missingPermission('chat.read'))
    expect(await chatRow(started)).toEqual(
      isAllowed ? expect.objectContaining({ ownerUserId: member.userId }) : undefined,
    )
  },
)

test('posting in a public channel makes a non-participant a Prompter and leaves a participant’s role alone', async () => {
  const roleOf = async (userId: string) =>
    (
      await database.$client`select role_id from chat_participants where chat_id = 'chat-standup' and user_id = ${userId}`
    )[0]?.role_id
  expect(await roleOf(lee)).toBeUndefined()
  expect(await sendTo({ workspaceId: acme, userId: lee }, 'chat-standup', 'message-lee-joins', 'Hello')).toEqual(
    succeeded,
  )
  expect(await roleOf(lee)).toBe('prompter')
  expect(await sendTo(bobInAcme, 'chat-standup', 'message-owner-posts', 'Hi')).toEqual(succeeded)
  expect(await roleOf(bob)).toBe('owner')
})

const participantsOf = async (chatId: string) =>
  Object.fromEntries(
    (
      await database.$client<{ user_id: string; role_id: string }[]>`
        select user_id, role_id from chat_participants where chat_id = ${chatId}`
    ).map((row) => [row.user_id, row.role_id]),
  )
const addParticipant = (chatId: string, memberId: string, roleId: string) =>
  database.$client`
    insert into chat_participants (workspace_id, chat_id, user_id, role_id) values (${acme}, ${chatId}, ${memberId}, ${roleId})`
const otherThan = (userId: string) => (userId === lee ? bob : lee)
const memberChange = (member: typeof aliceInAcme, name: string, chatId: string, args: Record<string, unknown> = {}) =>
  resultOf(member, `conversation.${name}`, { workspaceId: acme, chatId, ...args })
const managers = ['owner'] as const

test.each(chatAccessRows(['editor', 'owner']))(
  'inviteMember needs members.invite: $name',
  async ({ member, isAllowed, ...role }) => {
    const chat = await chatAs(role)
    const invitee = otherThan(member.userId)
    expect(await memberChange(member, 'inviteMember', chat, { memberId: invitee, roleId: 'reader' })).toEqual(
      isAllowed ? succeeded : missingPermission('members.invite'),
    )
    expect((await participantsOf(chat))[invitee]).toBe(isAllowed ? 'reader' : undefined)
  },
)

test.each(chatAccessRows(managers))(
  'changeMemberRole needs members.manage: $name',
  async ({ member, isAllowed, ...role }) => {
    const chat = await chatAs(role)
    const target = otherThan(member.userId)
    await addParticipant(chat, target, 'reader')
    expect(await memberChange(member, 'changeMemberRole', chat, { memberId: target, roleId: 'prompter' })).toEqual(
      isAllowed ? succeeded : missingPermission('members.manage'),
    )
    expect((await participantsOf(chat))[target]).toBe(isAllowed ? 'prompter' : 'reader')
  },
)

test.each(chatAccessRows(managers))(
  'removeMember needs members.manage: $name',
  async ({ member, isAllowed, ...role }) => {
    const chat = await chatAs(role)
    const target = otherThan(member.userId)
    await addParticipant(chat, target, 'reader')
    expect(await memberChange(member, 'removeMember', chat, { memberId: target })).toEqual(
      isAllowed ? succeeded : missingPermission('members.manage'),
    )
    expect((await participantsOf(chat))[target]).toBe(isAllowed ? undefined : 'reader')
  },
)

test.each(
  chatAccessRows(['reader', 'prompter', 'editor']).map((row) => ({
    ...row,
    refusal:
      row.role === 'owner' ? 'The owner keeps the Owner role and stays in the chat' : 'This member is not in the chat',
  })),
)('leaveChat lets any participant but the owner leave: $name', async ({ member, isAllowed, refusal, ...role }) => {
  const chat = await chatAs(role)
  const roleBefore = (await participantsOf(chat))[member.userId]
  expect(await memberChange(member, 'leaveChat', chat)).toEqual(isAllowed ? succeeded : failedWith(refusal))
  expect((await participantsOf(chat))[member.userId]).toBe(isAllowed ? undefined : roleBefore)
})

test('inviting, changing a role, removing and leaving each record a member event by the acting member', async () => {
  const chat = await newChat({ participants: [{ memberId: bob, roleId: 'editor' }] })
  expect(await memberChange(bobInAcme, 'inviteMember', chat, { memberId: lee, roleId: 'prompter' })).toEqual(succeeded)
  expect(await memberChange(aliceInAcme, 'changeMemberRole', chat, { memberId: lee, roleId: 'reader' })).toEqual(
    succeeded,
  )
  expect(await memberChange(aliceInAcme, 'removeMember', chat, { memberId: lee })).toEqual(succeeded)
  expect(await memberChange(bobInAcme, 'leaveChat', chat)).toEqual(succeeded)
  expect(await participantsOf(chat)).toEqual({ [alice]: 'owner' })
  expect(await changesOf(chat)).toEqual([
    { seq: 1, type: 'member.invited', actor: bob, payload: { memberId: lee, roleId: 'prompter' } },
    { seq: 2, type: 'member.role_changed', actor: alice, payload: { memberId: lee, roleId: 'reader' } },
    { seq: 3, type: 'member.removed', actor: alice, payload: { memberId: lee } },
    { seq: 4, type: 'member.left', actor: bob, payload: { memberId: bob } },
  ])
})

test.each([
  [
    'an editor inviting with a role above their own',
    bobInAcme,
    'inviteMember',
    { memberId: lee, roleId: 'tool-keeper' },
    'You can only give a role within your own permissions',
  ],
  [
    'inviting as Owner',
    aliceInAcme,
    'inviteMember',
    { memberId: lee, roleId: 'owner' },
    'The Owner role cannot be given',
  ],
  [
    'inviting a non-member of the workspace',
    aliceInAcme,
    'inviteMember',
    { memberId: 'member-stranger', roleId: 'reader' },
    'Only members of this workspace can join a chat',
  ],
  [
    'inviting an existing participant',
    aliceInAcme,
    'inviteMember',
    { memberId: bob, roleId: 'reader' },
    'This member is already in the chat',
  ],
  [
    'inviting with a role that does not exist',
    aliceInAcme,
    'inviteMember',
    { memberId: lee, roleId: 'janitor' },
    'Role janitor was not found',
  ],
  [
    'changing the owner’s role',
    aliceInAcme,
    'changeMemberRole',
    { memberId: alice, roleId: 'reader' },
    'The owner keeps the Owner role and stays in the chat',
  ],
  [
    'assigning Owner',
    aliceInAcme,
    'changeMemberRole',
    { memberId: bob, roleId: 'owner' },
    'The Owner role cannot be given',
  ],
  [
    'removing the owner',
    aliceInAcme,
    'removeMember',
    { memberId: alice },
    'The owner keeps the Owner role and stays in the chat',
  ],
  ['removing a non-participant', aliceInAcme, 'removeMember', { memberId: lee }, 'This member is not in the chat'],
])('refuses %s and writes nothing', async (_, member, name, args, message) => {
  await database.$client`
    insert into chat_roles (workspace_id, id, name, permissions, built_in)
    values (${acme}, 'tool-keeper', 'Tool keeper', ${['chat.read', 'tools.manage']}, false)
    on conflict do nothing`
  const chat = await newChat({ participants: [{ memberId: bob, roleId: 'editor' }] })
  const participantsBefore = await participantsOf(chat)
  expect(await memberChange(member, name, chat, args)).toEqual(failedWith(message))
  expect(await participantsOf(chat)).toEqual(participantsBefore)
  expect(await changesOf(chat)).toEqual([])
})

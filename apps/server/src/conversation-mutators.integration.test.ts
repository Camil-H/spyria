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

test('startRuntimeFromMessage creates the runtime chat, its wrapped seed message, its origin and the author as Reader in one mutation, without a job', async () => {
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
  expect(
    await database.$client`select user_id, role_id from chat_participants where chat_id = 'chat-started' order by role_id`,
  ).toEqual([
    { user_id: alice, role_id: 'owner' },
    { user_id: bob, role_id: 'reader' },
  ] as never)
  const wrapper =
    'Conversation so far, from the channel thread in #Welcome:\n\nBob (member, human) · 2026-09-30 09:00 UTC\nWelcome to the team!'
  expect(await messagesOf('chat-started')).toMatchObject([
    { id: 'message-seed', seq: 2, authorId: alice, body: wrapper, replyToId: 'message-welcome-1' },
  ])
  expect(await database.query.runtimeOrigins.findMany({ where: { runtimeChatId: 'chat-started' } })).toEqual([
    {
      workspaceId: acme,
      chatId: 'chat-welcome',
      runtimeChatId: 'chat-started',
      messageId: 'message-welcome-1',
      startedBy: alice,
    },
  ])
  expect(await changesOf('chat-started')).toEqual([
    {
      seq: 1,
      type: 'chat.created',
      actor: alice,
      payload: {
        name: 'Welcome to the team!',
        type: 'runtime',
        projectId: 'project-onboarding',
        originChatId: 'chat-welcome',
      },
    },
    {
      seq: 2,
      type: 'message.posted',
      actor: alice,
      payload: expect.objectContaining({ body: wrapper, replyToId: 'message-welcome-1' }),
    },
    { seq: 3, type: 'member.invited', actor: alice, payload: { memberId: bob, roleId: 'reader' } },
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
  expect(await database.query.runtimeOrigins.findMany({ where: { runtimeChatId: 'chat-half-started' } })).toEqual([])
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
  expect((await changesOf('chat-standup')).filter(({ type }) => type === 'member.joined')).toEqual([
    { seq: expect.any(Number), type: 'member.joined', actor: lee, payload: { memberId: lee, roleId: 'prompter' } },
  ])
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

test.each(
  chatAccessRows(['public']).map((row) => ({
    ...row,
    refusal:
      row.role === 'outsider' ? missingPermission('chat.read') : failedWith('This member is already in the chat'),
  })),
)('joinChannel joins a public channel once, as Prompter: $name', async ({ member, isAllowed, refusal, ...role }) => {
  const chat = await chatAs(role, 'channel')
  const participantsBefore = await participantsOf(chat)
  expect(await memberChange(member, 'joinChannel', chat)).toEqual(isAllowed ? succeeded : refusal)
  expect(await participantsOf(chat)).toEqual(
    isAllowed ? { ...participantsBefore, [member.userId]: 'prompter' } : participantsBefore,
  )
  expect(await changesOf(chat)).toEqual(
    isAllowed
      ? [
          {
            seq: 1,
            type: 'member.joined',
            actor: member.userId,
            payload: { memberId: member.userId, roleId: 'prompter' },
          },
        ]
      : [],
  )
  if (isAllowed)
    expect(await memberChange(member, 'joinChannel', chat)).toEqual(failedWith('This member is already in the chat'))
})

test('joinChannel refuses a runtime chat to a non-participant', async () => {
  const chat = await newChat()
  expect(await memberChange(bobInAcme, 'joinChannel', chat)).toEqual(missingPermission('chat.read'))
  expect(await participantsOf(chat)).toEqual({ [alice]: 'owner' })
})

const replyTo = (
  member: typeof aliceInAcme,
  chatId: string,
  threadRootId: string,
  id = `message-${crypto.randomUUID()}`,
) =>
  resultOf(member, 'conversation.sendMessage', { workspaceId: acme, id, chatId, text: 'In the thread', threadRootId })
const rootIn = async (chatId: string) => {
  const root = `message-${crypto.randomUUID()}`
  await sendTo(aliceInAcme, chatId, root, 'Root')
  return root
}

test.each(chatAccessRows(posters))(
  'sendMessage in a thread needs chat.post and records the reply as posted with its root: $name',
  async ({ member, isAllowed, ...role }) => {
    const chat = await chatAs(role, 'channel')
    const root = await rootIn(chat)
    const reply = `message-${crypto.randomUUID()}`
    expect(await replyTo(member, chat, root, reply)).toEqual(isAllowed ? succeeded : missingPermission('chat.post'))
    expect(await messageRow(reply)).toEqual(
      isAllowed ? expect.objectContaining({ chatId: chat, threadRootId: root, replyToId: null }) : undefined,
    )
    expect((await changesOf(chat)).at(-1)).toEqual(
      isAllowed
        ? {
            seq: expect.any(Number),
            type: 'message.posted',
            actor: member.userId,
            payload: { kind: 'member', body: 'In the thread', detail: null, replyToId: null, threadRootId: root },
          }
        : expect.objectContaining({ payload: expect.objectContaining({ body: 'Root' }) }),
    )
  },
)

test('a thread reply is refused in a runtime chat', async () => {
  const chat = await newChat()
  const root = await writtenMessage(chat, alice)
  const before = await countOf()
  expect(await replyTo(aliceInAcme, chat, root)).toEqual(failedWith('A runtime chat has no threads'))
  expect(await countOf()).toEqual(before)
})

test.each([
  [
    'a reply',
    async (chat: string, root: string) => {
      await replyTo(aliceInAcme, chat, root, `${root}-reply`)
      return `${root}-reply`
    },
  ],
  [
    'a deleted message',
    async (_: string, root: string) => {
      await resultOf(aliceInAcme, 'conversation.deleteMessage', { workspaceId: acme, messageId: root })
      return root
    },
  ],
  ['a message of another chat', async () => 'message-standup-1'],
  ['a message of another workspace', async () => 'message-general-1'],
  ['a message that does not exist', async () => 'message-missing'],
])('a thread reply is refused on %s as its root, and writes nothing', async (_, rootOf) => {
  const chat = await newChat({ type: 'channel' })
  const root = await rootOf(chat, await rootIn(chat))
  const before = await countOf()
  expect(await replyTo(aliceInAcme, chat, root)).toEqual(
    failedWith('A thread starts on a message of this chat that is not a reply and not deleted'),
  )
  expect(await countOf()).toEqual(before)
})

const threadMarkerOf = (userId: string, threadRootId: string) =>
  database.query.threadReadMarkers
    .findFirst({ where: { userId, threadRootId } })
    .then((marker) => marker && { chatId: marker.chatId, lastReadSeq: marker.lastReadSeq })
const markThreadRead = (member: typeof aliceInAcme, chatId: string, threadRootId: string) =>
  resultOf(member, 'conversation.markThreadRead', { workspaceId: acme, chatId, threadRootId })

test.each(chatAccessRows(readers))(
  'markThreadRead needs chat.read and moves the marker to the newest reply: $name',
  async ({ member, isAllowed, ...role }) => {
    const chat = await chatAs(role, 'channel')
    const root = await rootIn(chat)
    await replyTo(aliceInAcme, chat, root)
    expect(await markThreadRead(member, chat, root)).toEqual(isAllowed ? succeeded : missingPermission('chat.read'))
    expect(await threadMarkerOf(member.userId, root)).toEqual(isAllowed ? { chatId: chat, lastReadSeq: 2 } : undefined)
  },
)

test('markThreadRead never moves backwards and writes nothing for a thread without replies or of another chat', async () => {
  const chat = await newChat({ type: 'channel' })
  const root = await rootIn(chat)
  const rootWithoutReplies = await rootIn(chat)
  await replyTo(aliceInAcme, chat, root)
  expect(await markThreadRead(bobInAcme, chat, root)).toEqual(succeeded)
  expect(await threadMarkerOf(bob, root)).toEqual({ chatId: chat, lastReadSeq: 3 })
  await database.$client`update thread_read_markers set last_read_seq = 99 where user_id = ${bob}`
  expect(await markThreadRead(bobInAcme, chat, root)).toEqual(succeeded)
  expect(await threadMarkerOf(bob, root)).toEqual({ chatId: chat, lastReadSeq: 99 })
  expect(await markThreadRead(bobInAcme, chat, rootWithoutReplies)).toEqual(succeeded)
  expect(await markThreadRead(bobInAcme, 'chat-standup', root)).toEqual(succeeded)
  expect(await threadMarkerOf(bob, rootWithoutReplies)).toBeUndefined()
  expect(await database.query.threadReadMarkers.findMany({ where: { chatId: 'chat-standup' } })).toEqual([])
})

const quotedTimeOf = (date: Date | undefined) => `${date?.toISOString().slice(0, 16).replace('T', ' ')} UTC`
const startRuntimeFrom = async (messageId: string) => {
  const started = `chat-${crypto.randomUUID()}`
  expect(
    await resultOf(aliceInAcme, 'conversation.startRuntimeFromMessage', {
      workspaceId: acme,
      id: `message-${crypto.randomUUID()}`,
      chatId: started,
      messageId,
    }),
  ).toEqual(succeeded)
  return {
    wrapper: (await messagesOf(started))[0]?.body,
    participants: await database.$client`
      select user_id, role_id from chat_participants where chat_id = ${started} order by role_id`,
    origin: await database.query.runtimeOrigins.findFirst({ where: { runtimeChatId: started } }),
    invited: (await changesOf(started)).filter((change) => change.type === 'member.invited'),
  }
}
const threadWithDeletedReply = async () => {
  const chat = await newChat({ type: 'channel' })
  const root = await rootIn(chat)
  const bobReply = `message-${crypto.randomUUID()}`
  const deletedReply = `message-${crypto.randomUUID()}`
  const ownReply = `message-${crypto.randomUUID()}`
  await replyTo(bobInAcme, chat, root, bobReply)
  await replyTo({ workspaceId: acme, userId: lee }, chat, root, deletedReply)
  await resultOf({ workspaceId: acme, userId: lee }, 'conversation.deleteMessage', {
    workspaceId: acme,
    messageId: deletedReply,
  })
  await replyTo(aliceInAcme, chat, root, ownReply)
  const timeOf = async (id: string) => quotedTimeOf((await messageRow(id))?.createdAt)
  return {
    chat,
    root,
    bobReply,
    wrapper: [
      'Conversation so far, from the channel thread in #Runtime chat:',
      `Alice (member, human) · ${await timeOf(root)}\nRoot`,
      `Bob (member, human) · ${await timeOf(bobReply)}\nIn the thread`,
      `Alice (member, human) · ${await timeOf(ownReply)}\nIn the thread`,
    ].join('\n\n'),
  }
}

test.each([
  ['the root', ({ root }: { root: string }) => root],
  ['a reply', ({ bobReply }: { bobReply: string }) => bobReply],
])(
  'startRuntimeFromMessage from %s seeds the whole thread without its deleted reply and adds the other living author as Reader',
  async (_, sourceOf) => {
    const thread = await threadWithDeletedReply()
    const started = await startRuntimeFrom(sourceOf(thread))
    expect(started.wrapper).toBe(thread.wrapper)
    expect(started.participants).toEqual([
      { user_id: alice, role_id: 'owner' },
      { user_id: bob, role_id: 'reader' },
    ] as never)
    expect(started.invited).toEqual([
      { seq: expect.any(Number), type: 'member.invited', actor: alice, payload: { memberId: bob, roleId: 'reader' } },
    ])
    expect(started.origin).toMatchObject({ chatId: thread.chat, messageId: thread.root, startedBy: alice })
  },
)

test('startRuntimeFromMessage from a top-level message without replies seeds it alone and adds nobody when it is the starter’s', async () => {
  const chat = await newChat({ type: 'channel' })
  const root = await rootIn(chat)
  const started = await startRuntimeFrom(root)
  expect(started.wrapper).toBe(
    `Conversation so far, from the channel thread in #Runtime chat:\n\nAlice (member, human) · ${quotedTimeOf((await messageRow(root))?.createdAt)}\nRoot`,
  )
  expect(started.participants).toEqual([{ user_id: alice, role_id: 'owner' }] as never)
  expect(started.invited).toEqual([])
})

test('startRuntimeFromMessage leaves out of the participants a thread author who can no longer read the channel', async () => {
  const chat = await newChat({
    type: 'channel',
    visibility: 'private',
    participants: [
      { memberId: bob, roleId: 'prompter' },
      { memberId: lee, roleId: 'prompter' },
    ],
  })
  const root = await rootIn(chat)
  await replyTo({ workspaceId: acme, userId: lee }, chat, root)
  await replyTo(bobInAcme, chat, root)
  await database.$client`delete from chat_participants where chat_id = ${chat} and user_id = ${lee}`
  const started = await startRuntimeFrom(root)
  expect(started.wrapper).toContain('Lee (member, human)')
  expect(started.participants).toEqual([
    { user_id: alice, role_id: 'owner' },
    { user_id: bob, role_id: 'reader' },
  ] as never)
})

const forkOf = async (member: typeof aliceInAcme, sourceChatId: string) => {
  const forked = `chat-${crypto.randomUUID()}`
  const wrapperId = `message-${crypto.randomUUID()}`
  const result = await resultOf(member, 'conversation.forkChat', {
    workspaceId: acme,
    id: wrapperId,
    chatId: forked,
    sourceChatId,
  })
  return { result, forked, wrapperId }
}

test.each(chatAccessRows(readers))(
  'forkChat needs chat.read on a runtime source chat: $name',
  async ({ member, isAllowed, ...role }) => {
    const source = await chatAs(role)
    const { result, forked } = await forkOf(member, source)
    const isForked = isAllowed && !role.isPublic
    expect(result).toEqual(
      isForked
        ? succeeded
        : isAllowed
          ? failedWith('Only runtime chats can be forked')
          : missingPermission('chat.read'),
    )
    expect(await chatRow(forked)).toEqual(
      isForked
        ? expect.objectContaining({ ownerUserId: member.userId, originChatId: source, visibility: 'private' })
        : undefined,
    )
  },
)

test('forkChat gives the forker a private runtime chat seeded with the source’s member and agent messages, and leaves the source unchanged', async () => {
  const source = await newChat({ participants: [{ memberId: bob, roleId: 'reader' }] })
  const at = (minute: number) => `2026-10-17T09:0${minute}:00.000Z`
  const rows = [
    { seq: 1, kind: 'member', authorId: alice, body: 'Find the bug.', deletedAt: null },
    { seq: 2, kind: 'step', authorId: null, body: 'Read invoice.ts', deletedAt: null },
    { seq: 3, kind: 'agent', authorId: null, body: 'Found it.', deletedAt: null },
    { seq: 4, kind: 'notice', authorId: null, body: 'Stopped by Alice', deletedAt: null },
    { seq: 5, kind: 'member', authorId: alice, body: '', deletedAt: at(6) },
    { seq: 6, kind: 'member', authorId: alice, body: 'Fix it.', deletedAt: null },
  ]
  for (const { seq, kind, authorId, body, deletedAt } of rows)
    await database.$client`
      insert into messages (workspace_id, chat_id, id, seq, kind, author_id, body, created_at, deleted_at)
      values (${acme}, ${source}, ${`message-${crypto.randomUUID()}`}, ${seq}, ${kind}, ${authorId}, ${body}, ${at(seq)}, ${deletedAt})`
  const sourceBefore = {
    messages: await messagesOf(source),
    chat: await chatRow(source),
    events: await eventsOf(source),
  }

  const { result, forked, wrapperId } = await forkOf(bobInAcme, source)

  expect(result).toEqual(succeeded)
  expect(await chatRow(forked)).toMatchObject({
    type: 'runtime',
    name: 'Runtime chat (fork)',
    originChatId: source,
    ownerUserId: bob,
    visibility: 'private',
  })
  expect(await database.$client`select user_id, role_id from chat_participants where chat_id = ${forked}`).toEqual([
    { user_id: bob, role_id: 'owner' },
  ] as never)
  const wrapper = [
    'Conversation so far, from the runtime chat Runtime chat:',
    'Alice (member, human) · 2026-10-17 09:01 UTC\nFind the bug.',
    'Agent (agent) · 2026-10-17 09:03 UTC\nFound it.',
    'Alice (member, human) · 2026-10-17 09:06 UTC\nFix it.',
  ].join('\n\n')
  expect(await messagesOf(forked)).toMatchObject([
    { id: wrapperId, seq: 2, kind: 'member', authorId: bob, body: wrapper, replyToId: wrapperId },
  ])
  expect(await changesOf(forked)).toEqual([
    {
      seq: 1,
      type: 'chat.created',
      actor: bob,
      payload: { name: 'Runtime chat (fork)', type: 'runtime', projectId: null, originChatId: source },
    },
    {
      seq: 2,
      type: 'message.posted',
      actor: bob,
      payload: expect.objectContaining({ body: wrapper, replyToId: wrapperId }),
    },
  ])
  expect(await jobsOf(wrapperId)).toEqual([])
  expect({ messages: await messagesOf(source), chat: await chatRow(source), events: await eventsOf(source) }).toEqual(
    sourceBefore,
  )
  expect(
    await database.$client`select user_id, role_id from chat_participants where chat_id = ${source} order by role_id`,
  ).toEqual([
    { user_id: alice, role_id: 'owner' },
    { user_id: bob, role_id: 'reader' },
  ] as never)
})

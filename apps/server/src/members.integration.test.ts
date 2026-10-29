import { expect, test } from 'bun:test'
import {
  acme,
  addParticipant,
  alice,
  aliceInAcme,
  bob,
  bobInAcme,
  chatAccessRows,
  chatAs,
  failedWith,
  lee,
  missingPermission,
  newChat,
  openSharedTestApp,
  sendTo,
  succeeded,
} from './testing/testing.ts'

const { database, resultOf, changesOf } = await openSharedTestApp()

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

test('posting in a private chat never joins it: a removed member is refused and no member.joined is recorded', async () => {
  const chat = await newChat({
    type: 'channel',
    visibility: 'private',
    participants: [{ memberId: bob, roleId: 'prompter' }],
  })
  expect(await sendTo(bobInAcme, chat, `message-${crypto.randomUUID()}`, 'Before')).toEqual(succeeded)
  expect(
    await resultOf(aliceInAcme, 'conversation.removeMember', { workspaceId: acme, chatId: chat, memberId: bob }),
  ).toEqual(succeeded)
  expect(await sendTo(bobInAcme, chat, `message-${crypto.randomUUID()}`, 'After')).toEqual(
    missingPermission('chat.post'),
  )
  expect((await changesOf(chat)).filter(({ type }) => type.startsWith('member.'))).toEqual([
    { seq: expect.any(Number), type: 'member.removed', actor: alice, payload: { memberId: bob } },
  ])
})

const participantsOf = async (chatId: string) =>
  Object.fromEntries(
    (
      await database.$client<{ user_id: string; role_id: string }[]>`
        select user_id, role_id from chat_participants where chat_id = ${chatId}`
    ).map((row) => [row.user_id, row.role_id]),
  )
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

test.each([
  ['inviting as Reader', 'inviteMember', { memberId: lee, roleId: 'reader' }],
  ['changing a role to Reader', 'changeMemberRole', { memberId: bob, roleId: 'reader' }],
  ['removing a member', 'removeMember', { memberId: bob }],
])('a public channel refuses %s and writes nothing, the same change passes once private', async (_, name, args) => {
  const publicChannel = await newChat({ type: 'channel', participants: [{ memberId: bob, roleId: 'prompter' }] })
  expect(await memberChange(aliceInAcme, name, publicChannel, args)).toEqual(
    failedWith('Everyone can read and post in a public chat; make it private to restrict someone'),
  )
  expect(await participantsOf(publicChannel)).toEqual({ [alice]: 'owner', [bob]: 'prompter' })
  expect(await changesOf(publicChannel)).toEqual([])
  const privateChannel = await newChat({
    type: 'channel',
    visibility: 'private',
    participants: [{ memberId: bob, roleId: 'prompter' }],
  })
  expect(await memberChange(aliceInAcme, name, privateChannel, args)).toEqual(succeeded)
})

test('changeMemberRole refuses a role above the manager’s own permissions and allows one within them', async () => {
  await database.$client`
    insert into chat_roles (workspace_id, id, name, permissions, built_in)
    values (${acme}, 'member-manager', 'Member manager', ${['chat.read', 'chat.post', 'members.manage']}, false)
    on conflict do nothing`
  const chat = await newChat({
    participants: [
      { memberId: bob, roleId: 'member-manager' },
      { memberId: lee, roleId: 'reader' },
    ],
  })
  expect(await memberChange(bobInAcme, 'changeMemberRole', chat, { memberId: lee, roleId: 'editor' })).toEqual(
    failedWith('You can only give a role within your own permissions'),
  )
  expect((await participantsOf(chat))[lee]).toBe('reader')
  expect(await memberChange(bobInAcme, 'changeMemberRole', chat, { memberId: lee, roleId: 'prompter' })).toEqual(
    succeeded,
  )
  expect((await participantsOf(chat))[lee]).toBe('prompter')
})

test.each(
  chatAccessRows(['public']).map((row) => ({
    ...row,
    refusal:
      row.role === 'outsider' ? missingPermission('chat.read') : failedWith('This member is already in the chat'),
  })),
)('joinChat joins a public channel once, as Prompter: $name', async ({ member, isAllowed, refusal, ...role }) => {
  const chat = await chatAs(role, 'channel')
  const participantsBefore = await participantsOf(chat)
  expect(await memberChange(member, 'joinChat', chat)).toEqual(isAllowed ? succeeded : refusal)
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
    expect(await memberChange(member, 'joinChat', chat)).toEqual(failedWith('This member is already in the chat'))
})

test('joinChat refuses a private AI chat to a non-participant and joins a public one as Prompter', async () => {
  const privateChat = await newChat()
  expect(await memberChange(bobInAcme, 'joinChat', privateChat)).toEqual(missingPermission('chat.read'))
  expect(await participantsOf(privateChat)).toEqual({ [alice]: 'owner' })
  const publicChat = await newChat({ visibility: 'public' })
  expect(await memberChange(bobInAcme, 'joinChat', publicChat)).toEqual(succeeded)
  expect(await participantsOf(publicChat)).toEqual({ [alice]: 'owner', [bob]: 'prompter' })
})

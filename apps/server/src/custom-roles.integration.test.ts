import { beforeEach, expect, test } from 'bun:test'
import {
  acme,
  asMember,
  alice,
  aliceInAcme,
  failedWith,
  lee,
  missingPermission,
  newChat,
  openSharedTestApp,
  bob,
  bobInAcme,
  sendTo,
  succeeded,
  workspaceEventsOf,
} from './testing/testing.ts'

const { database, resultOf } = await openSharedTestApp()

const reviewerId = 'role-reviewer'
const notAdmin = failedWith('Only a workspace admin can manage roles')
const roleChange = (member: typeof aliceInAcme, name: string, args: Record<string, unknown>) =>
  resultOf(member, `workspace.${name}ChatRole`, { workspaceId: acme, ...args })
const createRole = (args: { id?: string; name: string; permissions: string[] }, member = aliceInAcme) =>
  roleChange(member, 'create', { id: reviewerId, ...args })
const updateRole = (args: { roleId?: string; name: string; permissions: string[] }, member = aliceInAcme) =>
  roleChange(member, 'update', { roleId: reviewerId, ...args })
const deleteRole = (roleId = reviewerId, member = aliceInAcme) => roleChange(member, 'delete', { roleId })
const roleRowsOf = async () => [
  ...(await database.$client`
    select id, name, permissions, built_in as "builtIn" from chat_roles
    where workspace_id = ${acme} and not built_in order by id`),
]
const roleEventsOf = async () => (await workspaceEventsOf(database)).filter(({ type }) => type.startsWith('role.'))
const chatChange = (member: typeof aliceInAcme, name: string, chatId: string, args: Record<string, unknown>) =>
  resultOf(member, `conversation.${name}`, { workspaceId: acme, chatId, ...args })
const reviewer = { name: 'Reviewer', permissions: ['session.configure'] }

beforeEach(async () => {
  await database.$client`delete from chat_participants where role_id like 'role-%'`
  await database.$client`delete from chat_roles where not built_in`
  await database.$client`delete from workspace_events where type like 'role.%'`
})

test('an admin creates, renames, re-permissions and deletes a custom role, each recorded as a role event', async () => {
  expect(await createRole(reviewer)).toEqual(succeeded)
  expect(await roleRowsOf()).toEqual([
    { id: reviewerId, name: 'Reviewer', permissions: ['chat.read', 'session.configure'], builtIn: false },
  ])
  expect(await updateRole({ name: ' Critic ', permissions: ['chat.post', 'chat.read'] })).toEqual(succeeded)
  expect(await roleRowsOf()).toEqual([
    { id: reviewerId, name: 'Critic', permissions: ['chat.read', 'chat.post'], builtIn: false },
  ])
  expect(await deleteRole()).toEqual(succeeded)
  expect(await roleRowsOf()).toEqual([])
  expect(await roleEventsOf()).toEqual([
    {
      type: 'role.created',
      actorId: alice,
      payload: { roleId: reviewerId, name: 'Reviewer', permissions: ['chat.read', 'session.configure'] },
    },
    {
      type: 'role.updated',
      actorId: alice,
      payload: { roleId: reviewerId, name: 'Critic', permissions: ['chat.read', 'chat.post'] },
    },
    { type: 'role.deleted', actorId: alice, payload: { roleId: reviewerId, name: 'Critic' } },
  ])
  const audit = JSON.parse((await asMember(alice, 'GET', '/api/audit-log?group=Roles')).body)
  expect(audit.entries.map(({ person, action, target }: Record<string, string>) => [person, action, target])).toEqual([
    ['Alice', 'Deleted a chat role', 'Critic'],
    ['Alice', 'Changed a chat role', 'Critic'],
    ['Alice', 'Created a chat role', 'Reviewer'],
  ])
})

test('a member who is not an admin can neither create, change nor delete a role', async () => {
  expect(await createRole({ id: 'role-bob', ...reviewer }, bobInAcme)).toEqual(notAdmin)
  expect(await createRole(reviewer)).toEqual(succeeded)
  expect(await updateRole({ name: 'Mine', permissions: [] }, bobInAcme)).toEqual(notAdmin)
  expect(await deleteRole(reviewerId, bobInAcme)).toEqual(notAdmin)
  expect(await roleRowsOf()).toEqual([
    { id: reviewerId, name: 'Reviewer', permissions: ['chat.read', 'session.configure'], builtIn: false },
  ])
  expect((await roleEventsOf()).map(({ type }) => type)).toEqual(['role.created'])
})

test('names are 1 to 40 characters, unique whatever their case and never a built-in name; permissions come from the kernel; built-ins stay fixed', async () => {
  expect(await createRole(reviewer)).toEqual(succeeded)
  expect(await createRole({ id: 'role-blank', name: '  ', permissions: [] })).toEqual(
    failedWith('A role name has 1 to 40 characters'),
  )
  expect(await createRole({ id: 'role-long', name: 'R'.repeat(41), permissions: [] })).toEqual(
    failedWith('A role name has 1 to 40 characters'),
  )
  expect(await createRole({ id: 'role-copy', name: 'REVIEWER', permissions: [] })).toEqual(
    failedWith('A role named REVIEWER already exists'),
  )
  expect(await createRole({ id: 'role-owner', name: 'owner', permissions: [] })).toEqual(
    failedWith('owner is the name of a built-in role'),
  )
  expect(await createRole({ id: 'role-unknown', name: 'Deleter', permissions: ['chat.delete'] })).toEqual(
    failedWith('chat.delete is not a chat permission'),
  )
  expect(await updateRole({ name: 'reviewer', permissions: [] })).toEqual(succeeded)
  for (const roleId of ['reader', 'role-missing']) {
    expect(await updateRole({ roleId, name: 'Renamed', permissions: [] })).toEqual(
      failedWith(`${roleId} is not a custom role of this workspace`),
    )
    expect(await deleteRole(roleId)).toEqual(failedWith(`${roleId} is not a custom role of this workspace`))
  }
  expect(await roleRowsOf()).toEqual([{ id: reviewerId, name: 'reviewer', permissions: ['chat.read'], builtIn: false }])
  expect(
    (await database.$client`select name from chat_roles where workspace_id = ${acme} and id = 'reader'`)[0],
  ).toEqual({ name: 'Reader' })
})

test('a role held in chats cannot be deleted, with the count of members and chats, until nobody holds it', async () => {
  expect(await createRole(reviewer)).toEqual(succeeded)
  const firstChat = await newChat({ participants: [{ memberId: lee, roleId: reviewerId }] })
  const secondChat = await newChat({
    participants: [
      { memberId: lee, roleId: reviewerId },
      { memberId: bob, roleId: reviewerId },
    ],
  })
  const thirdChat = await newChat({ participants: [{ memberId: bob, roleId: reviewerId }] })
  expect(await deleteRole()).toEqual(failedWith('Reviewer is held by 2 members in 3 chats; change their role first'))
  for (const [chatId, memberId] of [
    [firstChat, lee],
    [secondChat, lee],
    [secondChat, bob],
  ] as const)
    expect(await chatChange(aliceInAcme, 'changeMemberRole', chatId, { memberId, roleId: 'reader' })).toEqual(succeeded)
  expect(await deleteRole()).toEqual(failedWith('Reviewer is held by 1 member in 1 chat; change their role first'))
  expect(await chatChange(aliceInAcme, 'removeMember', thirdChat, { memberId: bob })).toEqual(succeeded)
  expect(await deleteRole()).toEqual(succeeded)
})

test('editing a held role applies at once to the server checks of its holders', async () => {
  expect(await createRole(reviewer)).toEqual(succeeded)
  const chat = await newChat({
    type: 'channel',
    visibility: 'private',
    participants: [{ memberId: lee, roleId: reviewerId }],
  })
  const leeInAcme = { workspaceId: acme, userId: lee }
  expect(await chatChange(leeInAcme, 'stopAgent', chat, {})).toEqual(succeeded)
  expect(await sendTo(leeInAcme, chat, `message-${crypto.randomUUID()}`, 'Before')).toEqual(
    missingPermission('chat.post'),
  )
  expect(await updateRole({ name: 'Reviewer', permissions: ['chat.post'] })).toEqual(succeeded)
  expect(await sendTo(leeInAcme, chat, `message-${crypto.randomUUID()}`, 'After')).toEqual(succeeded)
  expect(await chatChange(leeInAcme, 'stopAgent', chat, {})).toEqual(missingPermission('session.configure'))
})

test('a custom role is given within the giver’s own permissions, never without chat.post in a public channel', async () => {
  expect(await createRole(reviewer)).toEqual(succeeded)
  expect(
    await createRole({ id: 'role-poster', name: 'Poster', permissions: ['chat.post', 'session.configure'] }),
  ).toEqual(succeeded)
  expect(await createRole({ id: 'role-keeper', name: 'Keeper', permissions: ['tools.manage'] })).toEqual(succeeded)
  const privateChat = await newChat({ participants: [{ memberId: bob, roleId: 'editor' }] })
  expect(await chatChange(bobInAcme, 'inviteMember', privateChat, { memberId: lee, roleId: 'role-keeper' })).toEqual(
    failedWith('You can only give a role within your own permissions'),
  )
  expect(await chatChange(bobInAcme, 'inviteMember', privateChat, { memberId: lee, roleId: reviewerId })).toEqual(
    succeeded,
  )
  const channel = await newChat({ type: 'channel', participants: [{ memberId: lee, roleId: 'prompter' }] })
  expect(await chatChange(aliceInAcme, 'changeMemberRole', channel, { memberId: lee, roleId: reviewerId })).toEqual(
    failedWith('Everyone can read and post in a public chat; make it private to restrict someone'),
  )
  expect(await chatChange(aliceInAcme, 'changeMemberRole', channel, { memberId: lee, roleId: 'role-poster' })).toEqual(
    succeeded,
  )
})

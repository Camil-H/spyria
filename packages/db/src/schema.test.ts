import { expect, test } from 'bun:test'
import { builtInChatRoles, type ChatPermission, chatId, type MemberId } from '@spyria/kernel'
import { acme, alice, bob, createMockSnapshot, globex, lee } from './mock-data.ts'
import { chatParticipantsIn, chatPermissionsIn, type Snapshot } from './schema.ts'

const snapshot = createMockSnapshot()
const permissionsOn = (chat: string, memberId: MemberId, rows: Snapshot = snapshot) =>
  rows.chats.filter((row) => row.id === chatId(chat)).map(chatPermissionsIn(rows, acme, memberId))[0]
const rolePermissions = (roleId: string) => builtInChatRoles.find((role) => role.id === roleId)?.permissions

test.each([
  ['the owner', 'chat-invoice-bug', alice, rolePermissions('owner')],
  ['a prompter', 'chat-invoice-bug', bob, rolePermissions('prompter')],
  ['a reader', 'chat-invoice-bug', lee, rolePermissions('reader')],
  ['a non-participant of a private chat', 'chat-research', bob, []],
  ['a non-participant of a public channel', 'chat-welcome', lee, ['chat.read', 'chat.post'] as ChatPermission[]],
])('%s gets the permissions of their role row on the chat', (_, chat, memberId, permissions) => {
  expect(permissionsOn(chat, memberId)).toEqual(permissions ?? [])
})

test('a role row of another workspace grants nothing', () => {
  const otherWorkspaceRoles = { ...snapshot, chatRoles: snapshot.chatRoles.filter((role) => role.workspaceId !== acme) }
  expect(permissionsOn('chat-research', alice, otherWorkspaceRoles)).toEqual([])
})

test('the participants of a chat are its rows in its workspace only, none for an unknown chat', () => {
  const participantsOf = (workspace: typeof acme, chat: string) =>
    chatParticipantsIn(snapshot, workspace, chatId(chat)).map(({ memberId, roleId }) => [memberId, roleId])
  expect(participantsOf(acme, 'chat-invoice-bug')).toEqual([
    [alice, 'owner'],
    [bob, 'prompter'],
    [lee, 'reader'],
  ])
  expect(participantsOf(globex, 'chat-invoice-bug')).toEqual([])
  expect(participantsOf(acme, 'chat-unknown')).toEqual([])
})

test('each snapshot gets its own participant index, so a changed snapshot answers with its own rows', () => {
  expect(permissionsOn('chat-research', bob)).toEqual([])
  const withBob: Snapshot = {
    ...snapshot,
    chatMembers: [
      ...snapshot.chatMembers,
      { workspaceId: acme, chatId: chatId('chat-research'), memberId: bob, roleId: 'reader' },
    ],
  }
  expect(permissionsOn('chat-research', bob, withBob)).toEqual(rolePermissions('reader') ?? [])
  expect(chatParticipantsIn(withBob, acme, chatId('chat-research')).map(({ memberId }) => memberId)).toContain(bob)
  expect(permissionsOn('chat-research', bob)).toEqual([])
})

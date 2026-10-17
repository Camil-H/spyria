import { expect, test } from 'bun:test'
import { builtInChatRoles, type ChatPermission, chatId, type MemberId } from '@hq/kernel'
import { acme, alice, createMockSnapshot, lee, bob } from './mock-data.ts'
import { chatPermissionsIn, type Snapshot } from './schema.ts'

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
